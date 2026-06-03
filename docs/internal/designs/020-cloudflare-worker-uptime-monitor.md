---
id: ADR-020
title: Cloudflare Worker Uptime Monitor
status: Amended # amended by ADR-030 (alert state moved from KV to D1)
date: 2026-05-13
deciders: [platform]
consulted: []
tags: [design, adr, cloudflare, workers, d1, kv, monitoring]
supersedes: []
superseded_by: []
amended_by: [ADR-030]
links:
  - cloudflare-workers: https://developers.cloudflare.com/workers/
  - cloudflare-d1: https://developers.cloudflare.com/d1/
  - cloudflare-kv: https://developers.cloudflare.com/kv/
  - cloudflare-cron-triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
  - dlt-rest-api-source: https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic
  - dlt-cloudflare-d1: https://dlthub.com/context/source/cloudflare-d1
---

# Context

- We need uptime monitoring for public HTTP endpoints behind Cloudflare (services exposed via tunnels, Cloudflare-routed zones, etc.).
- Existing options have tradeoffs:
  - **Cloudflare Health Checks** require Pro plan ($20-25/mo per zone), limited to 10 checks on Pro, no custom alerting logic, no data warehouse integration.
  - **Managed services** (Better Stack, UptimeRobot, Pingdom) are external SaaS dependencies with their own pricing, data residency, and feature constraints.
  - **Self-hosted** (Uptime Kuma) monitors inside the same infrastructure it monitors, creating a shared-fate problem when the cluster goes down.
- We want a lightweight, open-sourceable uptime monitor that:
  1. Runs outside the infrastructure it monitors (Cloudflare's edge, not our cluster).
  2. Stores probe results in a queryable format with zero external dependencies.
  3. Supports configurable alerting on failure-state transitions.
  4. Costs near-zero at personal/homelab scale.
  5. Has a clean extension point for moving data to a cloud warehouse.

# Decision

Build a Cloudflare Worker that runs on a cron trigger, probes configured HTTP endpoints, writes results to D1, tracks failure streaks in KV, and fires webhook alerts on state transitions. D1 is the default and only storage backend. Data export to BigQuery (or any other warehouse) is handled by a separate dlt pipeline, not by the Worker itself.

## Architecture

```
Cron Trigger (every 1-5 min)
  -> Worker scheduled() handler
     -> For each configured endpoint:
        1. fetch(url), measure status / latency / error
        2. INSERT row into D1 (probe_results table)
        3. Read failure streak from KV
        4. Update streak, write back to KV
        5. If streak crossed alert threshold: POST to webhook
```

```
dlt pipeline (optional, scheduled externally)
  -> Query D1 via Cloudflare REST API
  -> Incremental load (cursor on row id or ts)
  -> Write to BigQuery / Postgres / Snowflake / etc.
```

## Storage: D1

D1 is the default probe result store. Every probe result is an INSERT. No external database dependency.

The Worker MUST bind to D1 natively. No Google service account, no JWT signing, no OAuth token exchange.

Schema:

```sql
CREATE TABLE probe_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    url TEXT NOT NULL,
    ok INTEGER NOT NULL,       -- 1 = true, 0 = false (SQLite has no BOOL)
    status INTEGER,
    latency_ms INTEGER,
    error TEXT,
    region_hint TEXT,
    response_snippet TEXT
);

CREATE INDEX idx_probe_ts ON probe_results(ts);
CREATE INDEX idx_probe_monitor_ts ON probe_results(monitor_id, ts);
```

D1 is the right default for an open-source tool. BigQuery is the wrong default because it requires GCP credentials, billing, and project setup. D1 requires nothing beyond a Cloudflare account.

Free-tier capacity at probe scale (validated against Cloudflare docs as of 2026-05-13):

| Metric                  | Free tier | 10 monitors at 1-min | 50 monitors at 1-min |
| ----------------------- | --------- | -------------------- | -------------------- |
| Rows written            | 100K/day  | ~14.4K/day           | ~72K/day             |
| Rows read (alert check) | 5M/day    | ~14.4K/day           | ~72K/day             |
| Storage                 | 5 GB      | ~10-20 MB/month      | ~50-100 MB/month     |

All within free-tier bounds. Storage, reads, and writes are independent quotas.

## State tracking: KV

> **Amended by [ADR-030](030-uptime-monitor-state-in-d1.md) (2026-06-03):** Alert
> state has been moved out of KV into a D1 `monitor_state` table, and the KV
> dependency removed entirely. Even one batched KV write per minute (1,440/day)
> exceeds the KV free tier (1,000 writes/day), so KV was never viable for a
> 1-minute cron at free-tier cost. The rest of this section is retained for
> historical context; see ADR-030 for the current design.

Failure streak state lives in KV, not D1. Each monitor gets one key with a JSON blob:

```json
{
  "consecutive_failures": 3,
  "last_status": "down",
  "last_ts": "2026-05-13T12:00:00Z"
}
```

One read + one write per cron run (batch all monitors into a single key if needed to stay under KV free-tier write limits).

Why KV over D1 for state:

- KV ops are sub-millisecond. Alert logic runs on every cron tick and MUST be fast.
- KV does not add row-count pressure to D1's daily write quota.
- KV TTLs provide automatic cleanup if the monitor stops running.

KV free-tier consideration: Free tier allows 1,000 writes/day. At 1-minute intervals, per-monitor keys would produce 1,440 writes/day (over the limit). The implementation SHOULD batch all monitor state into one KV key, bringing it to one write per run. For sub-2-minute intervals with per-monitor keys, Workers Paid ($5/mo) is required, which provides 1M writes/month.

## Alerting: webhook on state transition

The Worker MUST POST to a configured webhook URL when a monitor transitions from healthy to unhealthy or vice versa. The webhook payload includes monitor ID, current streak, timestamp, and last error.

No built-in email/SMS/PagerDuty integration. Webhooks are the lowest common denominator. Users wire webhooks to Discord, Slack, PagerDuty, or any other notification system.

## Data export: dlt (optional)

D1 is not a data warehouse. For users who want long-term analytics, dashboards, or cross-source queries, the recommended path is a dlt pipeline that periodically pulls from D1 and writes to BigQuery (or any dlt-supported destination).

Integration path (validated against dlt and Cloudflare D1 REST API docs):

1. D1 exposes a REST API at `POST /accounts/{account_id}/d1/database/{database_id}/query` with Bearer token auth.
2. dlt's `rest_api` verified source can query this endpoint with parameterized SQL.
3. dlt supports incremental loading via cursor columns (`id` or `ts`), so it only pulls new rows each run.
4. dlt writes to BigQuery, Postgres, Snowflake, DuckDB, etc. with automatic schema inference and evolution.

This MUST be documented as an integration guide in the project repo, not bundled with the Worker. The Worker does not know about dlt. dlt does not know about the Worker. D1 is the contract between them.

Why dlt over custom scripts:

- Declarative config vs. hand-rolled ETL.
- Incremental loading with cursor tracking is built-in.
- Schema evolution (new columns) is automatic.
- Multiple destinations supported without code changes.
- dlt is open-source, runs anywhere Python runs, and has a verified REST API source that maps directly to D1's query endpoint.

## What this is not

- Not a multi-region synthetic monitor. Cron triggers execute on Cloudflare's edge, but a single Worker cron run does not probe from multiple PoPs simultaneously.
- Not a replacement for an independent external monitor. If Cloudflare itself has issues, this monitor may also have issues. An external service (Better Stack, UptimeRobot) SHOULD monitor the 2-3 most critical endpoints as an independent check.
- Not a full observability platform. No traces, logs, or metrics beyond HTTP probe results.
- Not a status page. Results are in D1. A status page would be a separate project consuming the same data.

# Consequences

## Positive

- Near-zero cost at personal scale (free tier for 10 monitors at 2+ minute intervals, $5/mo Workers Paid for 1-minute intervals).
- Runs on Cloudflare's edge, outside the infrastructure it monitors.
- Open-sourceable with zero external dependencies beyond a Cloudflare account.
- Clean separation: Worker does monitoring, dlt does data movement.
- D1 provides queryable storage without needing a separate database.
- dlt integration provides a real-world use case for learning and validating the tool.

## Negative

- Single-region probes (Cloudflare edge, not multi-PoP). Does not replace a Pingdom/Better Stack for geographic coverage.
- Shared fate with Cloudflare. If Cloudflare Workers have issues, the monitor is also affected.
- D1 free tier limits (100K writes/day) cap throughput at roughly 70 monitors at 1-minute intervals before requiring Workers Paid.
- KV free tier (1K writes/day) requires either batching state into one key or Workers Paid for per-key state at sub-2-minute intervals.
- dlt pipeline is an external dependency for users who want warehouse export. It MUST be scheduled and monitored separately.

# Alternatives

- **Direct Worker -> BigQuery (no D1):** Worker writes directly to BigQuery via `tabledata.insertAll`. Rejected as default because it requires GCP credentials, BigQuery project setup, JWT auth in the Worker, and a GCP billing account. These are all barriers to adoption for an open-source tool. Available as a custom sink for users who want it.

- **Durable Objects for state:** Use Durable Objects for failure streak tracking. Provides strong consistency and exactly-once semantics. Rejected because DOs cost ~$0.50/mo per instance, the monitor has no concurrency problem (serial cron execution), and KV is sufficient. DOs solve a problem that does not exist at this scale.

- **Cloudflare Health Checks (Pro plan):** Use Cloudflare's built-in Health Checks. Rejected because it requires Pro plan ($20-25/mo per zone), is limited to 10 checks on Pro, has no custom alerting logic, no D1/warehouse integration, and is not open-sourceable. The Worker approach is free-tier-compatible and fully customizable.

- **Managed service (Better Stack / UptimeRobot):** Use an existing managed uptime monitor. Not rejected outright -- we SHOULD still use one for the 2-3 most critical endpoints as an independent external check. But a managed service does not provide custom probe logic, D1 storage, or warehouse integration. It is complementary, not a replacement.

# Security / Privacy / Compliance

- D1 query endpoint requires a Cloudflare API token with D1 Read or D1 Write permissions. The dlt pipeline MUST store this token in dlt secrets (`.dlt/secrets.toml` or environment variables), never in code.
- Webhook URLs MAY contain secrets (Discord webhook tokens, etc.). These MUST be stored as Worker secrets (`wrangler secret put`), not plain environment variables.
- Probe results contain endpoint URLs and response metadata. If monitoring internal services, consider whether URLs reveal infrastructure topology.
- No PII is collected. Probe results are synthetic HTTP measurements.
- The Worker runs on Cloudflare's edge. Data in transit between Worker -> D1 and Worker -> webhook is encrypted in transit by default.

# Operational Notes

- **Observability:** Worker logs via `console.log` appear in Cloudflare Workers real-time logs. D1 query metrics (rows_read, rows_written, duration) are returned in every query's `meta` object and available via Cloudflare dashboard and GraphQL Analytics API.
- **Cost:** Free tier for up to ~10 monitors at 2-minute intervals. Workers Paid ($5/mo) for 1-minute intervals or higher monitor counts. D1 storage at 5 GB free, then $0.75/GB-month. KV writes at $5/million on paid. dlt and BigQuery costs are separate and depend on destination.
- **Quotas/Limits:**
  - Workers Free: 5 cron triggers per account, 10ms CPU per invocation.
  - Workers Paid: 250 cron triggers per account, 30s CPU per cron invocation (< 1hr interval).
  - D1 Free: 100K writes/day, 5M reads/day, 5 GB storage.
  - KV Free: 1,000 writes/day, 100K reads/day, 1 GB storage.
- **Cron locality:** Cron triggers execute on underutilized machines on Cloudflare's network. The specific edge location varies per invocation. This is not a multi-region probe product.
- **Rollback:** Worker can be redeployed via `wrangler deploy`. D1 data is durable. KV state is ephemeral and rebuildable from D1.

# Status Transitions

- This is a new ADR. No prior ADR is amended or superseded.
- **Amended by ADR-030 (2026-06-03):** the "State tracking: KV" decision is
  superseded — alert state now lives in a D1 `monitor_state` table and the KV
  dependency is removed. The rest of this ADR (architecture, probe logic, D1
  history schema, webhook alerting, dlt export) still stands.

# Implementation Notes

- **Repository:** `jmmaloney4/sector7` as a Pulumi ComponentResource (`sector7:cloudflare:UptimeMonitor`). The component follows the existing WorkerSite pattern: Worker script is generated internally from a template function, all infrastructure is provisioned declaratively via Pulumi.
- **Component interface:** `UptimeMonitor` accepts monitor configurations (URL, expected codes, timeout), webhook URL, cron schedule, and optional existing D1/KV references. Creates D1 database, KV namespace, Worker script, and cron trigger. Exported from `@jmmaloney4/sector7/monitor`.
- **Worker script:** Generated by `generateMonitorScript()` in `monitor/monitor-script.ts`. Probe logic, D1 persistence, KV state tracking, and webhook alerting are all embedded in the generated script. Users never touch the Worker code directly.
- **Tests:** `tests/uptime-monitor.test.ts` using pulumi mock framework (same pattern as `worker-site.test.ts`).
- Worker runtime: TypeScript, Wrangler, `@cloudflare/workers-types`.
- Package manager: pnpm.
- dlt pipeline: Python, documented as an integration recipe, not shipped with the component.
- Open questions:
  - Whether to support TCP/DNS probes in addition to HTTP. Workers support `connect()` for TCP. DNS resolution is available. ICMP is not. Scope for a future extension.
  - Whether to add a simple HTML status page rendered by the Worker itself (reading from D1).
  - Whether to contribute the dlt pipeline back to dltHub as a verified source for Cloudflare D1.

# References

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [dlt REST API Source](https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic)
- [dlt Cloudflare D1 Source](https://dlthub.com/context/source/cloudflare-d1)
- [dlt Incremental Loading](https://dlthub.com/docs/general-usage/incremental-loading)
- [dlt REST API to BigQuery](https://dlthub.com/docs/pipelines/rest_api/load-data-with-python-from-rest_api-to-bigquery)
