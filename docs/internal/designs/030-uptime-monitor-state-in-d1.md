---
id: ADR-030
title: UptimeMonitor — Move Alert State from KV to D1
status: Accepted
date: 2026-06-03
deciders: [platform]
consulted: []
tags: [design, adr, cloudflare, workers, d1, kv, monitoring]
supersedes: []
superseded_by: []
links:
  - kv-pricing: https://developers.cloudflare.com/kv/platform/pricing/
  - kv-limits: https://developers.cloudflare.com/kv/platform/limits/
  - d1-pricing: https://developers.cloudflare.com/d1/platform/pricing/
  - d1-limits: https://developers.cloudflare.com/d1/platform/limits/
---

# Context

ADR-020 built the `UptimeMonitor` component on two Cloudflare storage backends:

- **D1** for probe-result history (`probe_results` table, one batch `INSERT` per cron run).
- **KV** for the failure-streak alert state machine, stored in per-monitor keys
  (`streak:<monitor_id>`) holding a JSON blob of `consecutive_failures`,
  `consecutive_successes`, `last_status`, `last_ts`.

The KV free tier allows only **1,000 `put` operations/day**. The component's
default cron schedule is `*/1 * * * *` (every minute), and `checkAndAlert()`
writes the streak state on **every** probe of **every** monitor. Even a single
monitor produces 1,440 KV writes/day, which exceeds the free tier and surfaces
the runtime error:

> You have exceeded the daily Cloudflare Workers KV free tier limit of 1000
> Workers KV put operations.

ADR-020 anticipated this and recommended batching all monitor state into one KV
key. But the math does not save us: one batched write per minute is still
1,440 writes/day — over the 1,000/day cap on its own. The shipped implementation
also never batched; it used per-monitor keys, so the problem worsens linearly
with monitor count. Avoiding it would have required Workers Paid ($5/mo), purely
to keep an ephemeral state machine alive.

D1's free tier allows **100,000 rows written/day** and **5,000,000 rows
read/day**, which comfortably absorbs both probe history and alert state at this
scale. The Worker already binds D1 (`env.DB`).

In scope: remove the KV namespace, binding, and all KV reads/writes from both the
generated Worker script and the Pulumi component; move alert state into a new D1
`monitor_state` table. Out of scope: the read API (`handleStats`), the dlt export
pipeline, and the downstream `garden` stack config (which needs a follow-up
`pulumi up`).

# Decision

`UptimeMonitor` MUST use **D1 only**. KV is removed entirely — not retained as an
optional backend.

## State table

Alert state lives in a `monitor_state` table appended to `DEFAULT_D1_SCHEMA` in
the same D1 database as `probe_results`. No second database, no Durable Objects.

```sql
CREATE TABLE IF NOT EXISTS monitor_state (
    monitor_id TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT 'healthy',
    last_ts TEXT,
    updated_at TEXT NOT NULL
);
```

There is exactly one row per monitor and lookups are always by `monitor_id`, so
the primary key is the only index needed.

## Alert logic

`checkAndAlert()` in `monitor-script.ts` reads and writes state via SQL instead
of KV:

- **Read:** `SELECT ... FROM monitor_state WHERE monitor_id = ?`, falling back to
  a zeroed `healthy` default when no row exists (first run, or after the table is
  created).
- **Write:** an `INSERT ... ON CONFLICT(monitor_id) DO UPDATE` UPSERT, kept inside
  `ctx.waitUntil()` for consistency and future-proofing (it is a cron handler, so
  `waitUntil` is not strictly required, but it matches the webhook calls and stays
  correct if the logic is ever reused in a `fetch` handler).

The streak-update and threshold-transition logic is otherwise unchanged.

## Component API

`UptimeMonitorArgs` MUST drop `kvNamespaceTitle` and `kvNamespaceId`. The
component MUST stop creating/referencing a `WorkersKvNamespace`, MUST drop the
`{ name: "KV", type: "kv_namespace" }` Worker binding, and MUST drop the
`kvNamespace` / `kvNamespaceId` outputs.

This is a **breaking change** to the component interface. Removing the args from
the TypeScript interface makes a stale config a compile-time error for typed
consumers, which is the cleanest signal; at runtime, extra properties are
ignored by JavaScript as usual. We intentionally do **not** add a runtime throw
for the removed args — the type-level error is sufficient and avoids carrying
dead validation code.

# Consequences

## Positive

- Fits the free tier: removes the KV 1,000-writes/day ceiling that made
  1-minute monitoring impossible without Workers Paid.
- One storage backend instead of two — simpler mental model, one schema, one
  binding.
- Alert state is now queryable alongside probe history in the same database.

## Negative

- More D1 queries per cron run: per monitor, 1 `SELECT` + 1 UPSERT on top of the
  existing batch `INSERT`. At 1 monitor/minute that is ~4,320 D1 queries/day,
  well within the 100K-rows-written/day and 5M-rows-read/day free tiers. D1
  allows 50 queries per Worker invocation on the free tier, so monitor count per
  run must stay well under 25 (2 queries each) — fine at homelab scale, worth
  noting before scaling to dozens of monitors in a single component.
- Loss of KV's implicit TTL cleanup: `monitor_state` rows persist indefinitely.
  The table is tiny and static (one row per monitor), so no cleanup mechanism is
  added.
- Breaking API change for consumers that passed `kvNamespace*` args (none do
  today; `garden`'s uptime stack uses defaults).

## Migration / data loss

The KV streak state is ephemeral and rebuildable. After the `garden` stack runs
`pulumi up` against this release:

1. The removed KV namespace resource is destroyed.
2. The Worker is updated to drop the KV binding and use D1 state.
3. The `monitor_state` table is created via the existing `D1Query` schema apply.

All monitors restart from `healthy` with zero streaks on the next cron run. The
only "loss" is in-flight streak counters, which re-accumulate within
`ALERT_THRESHOLD` (3) ticks.

# Alternatives

- **Batch all state into one KV key (ADR-020's suggestion):** still 1,440
  writes/day at 1-minute cadence — over the 1,000/day free cap. Rejected.
- **Workers Paid ($5/mo) for KV:** pays recurring money to keep an ephemeral
  state machine that D1 already stores for free. Rejected.
- **Durable Objects for state:** ~$0.50/mo per instance, solves a consistency
  problem the serial cron execution does not have. Rejected (consistent with
  ADR-020).

# Security / Privacy / Compliance

No change from ADR-020. The D1 query endpoint and apply token are unchanged; the
new table holds the same synthetic streak counters previously held in KV. No
PII.

# Operational Notes

- D1 query metrics (`rows_read`, `rows_written`, `duration`) appear in each
  query's `meta` and in the Cloudflare dashboard/GraphQL analytics.
- Free-tier headroom (validated 2026-06-03): KV 1,000 writes/day vs. D1 100,000
  rows written/day. The move trades one over-budget backend for one with ~100×
  the write headroom.

# Status Transitions

- This ADR amends **ADR-020**. ADR-020's "State tracking: KV" section is
  superseded by the `monitor_state` D1 table described here. ADR-020 remains the
  source of truth for the overall architecture, probe logic, D1 history schema,
  webhook alerting, and dlt export.

# Implementation Notes

- `packages/sector7/monitor/monitor-script.ts` — `checkAndAlert()` rewritten to
  D1 `SELECT` + UPSERT; all `env.KV` references removed.
- `packages/sector7/monitor/uptime-monitor.ts` — `monitor_state` added to
  `DEFAULT_D1_SCHEMA` (now exported for tests); KV namespace creation, binding,
  args, and outputs removed.
- `packages/sector7/tests/uptime-monitor.test.ts` — KV assertions replaced with
  KV-absence assertions; tests added for the `monitor_state` schema and for the
  generated script using D1 (not `env.KV`) for state.
- Follow-up (separate task): bump the `garden` `@jmmaloney4/sector7` dependency
  and run `pulumi up` in `deploy/services/uptime/`.

# References

- [Cloudflare KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/) — 1,000 writes/day free
- [Cloudflare KV Limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) — 100K rows written/day free
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) — 50 queries/invocation free tier
- ADR-020: `020-cloudflare-worker-uptime-monitor.md`
