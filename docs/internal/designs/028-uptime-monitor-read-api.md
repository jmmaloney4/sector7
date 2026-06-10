---
id: ADR-028
title: Uptime Monitor Read Api
status: proposed
date: 2026-05-24
---

# ADR 028: Uptime Monitor Read Api

*Date:* 2026-05-24
*Status:* proposed

**Related PR:** https://github.com/jmmaloney4/sector7/pull/227

This ADR is currently being developed in linked pull request above.
Please refer to that PR for current content and discussion.

## Update (2026-06-10): first-party consumers may bypass the read API and query D1 directly

The garden `bifrost` landing page needs uptime history (per-window
`uptime_pct`, `checks_total`, `checks_up`) to render its status panel. Rather
than depend on this read API — which is still `proposed` and whose worker
`/stats` handler is presently a placeholder that returns no D1 data — garden
reads the monitor's `probe_results` table **directly** via the Cloudflare D1
HTTP API (`POST /accounts/{account_id}/d1/database/{database_id}/query`) using a
read-scoped Cloudflare API token, and does the aggregation itself
(`SUM(ok)/COUNT(*)` bucketed by time window).

Rationale for the direct-D1 route, for a trusted first-party in-cluster
consumer:

- **No new public surface.** The worker need not expose (or harden) an
  authenticated `/stats` endpoint for this use case, so it does not block on the
  Cloudflare Access Service Token / JWT-assertion work this ADR tracks.
- **Schema is already sufficient.** `probe_results` (`ts, monitor_id, ok, status, latency_ms, error, region_hint`, ADR-030) carries everything a
  consumer needs to compute uptime; no worker-side aggregation API is required.
- **Credential is well-understood.** A D1-read-scoped API token is a standard,
  narrowly-scoped Cloudflare credential, managed like any other secret on the
  consumer side.

Implication for this ADR: the authenticated read API remains the right answer
for **untrusted or browser/cross-tenant consumers** that should not hold a
Cloudflare API token or see raw D1. It is **not** on the critical path for
first-party backends that can be trusted with a scoped D1 token. This lowers the
urgency of completing PR #227 for garden's needs, but does not supersede it.

Consumer-side implementation lives in garden (`services/bifrost`); a garden ADR
records the decision on that side.
