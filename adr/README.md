# Architecture Decision Records (ADR)

An Architecture Decision Record (ADR) captures an important architecture decision along with its context and consequences.

## Conventions

- Directory: `adr`
- Naming:
  - Use date-prefixed files: `YYYY-MM-DD-choose-database.md`
  - If the repo already uses slug-only names, keep that: `choose-database.md`
- Status values: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`

## Workflow

- Create a new ADR as `proposed`.
- Discuss and iterate.
- When the team commits: mark it `accepted` (or `rejected`).
- If replaced later: create a new ADR and mark the old one `superseded` with a link.

## ADRs

- [Adopt architecture decision records](2026-10-19-adopt-architecture-decision-records.md) (accepted, 2026-10-19)
- [Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md) (accepted, 2026-10-19)
- [Read Session Log Files incrementally from an Ack-confirmed offset](2026-10-19-read-session-log-files-incrementally-from-acked-offset.md) (superseded, 2026-10-19)
- [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md) (accepted, 2026-10-22)
- [Implement the Client Adapter Daemon and Plugins in TypeScript](2026-10-22-implement-daemon-and-plugins-in-typescript.md) (accepted, 2026-10-22)
- [Let each Plugin define its read trigger and reading method](2026-10-22-let-plugins-define-read-trigger-and-method.md) (accepted, 2026-10-22)
- [Merge Wire Event and Canonical Event into Session Log Event](2026-10-24-merge-wire-event-and-canonical-event-into-session-log-event.md) (accepted, 2026-10-24)
- [Keep Session Log Events as the source data and derive the activity model](2026-10-28-keep-session-log-events-as-source-and-derive-activity-model.md) (proposed, 2026-10-28)
- [Store Main Server data in SQLite](2026-10-28-store-main-server-data-in-sqlite.md) (proposed, 2026-10-28)
- [Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md) (accepted, 2026-10-29)
- [Send Session Log Events one record per Transport Unit](2026-10-29-send-session-log-events-one-record-per-transport-unit.md) (accepted, 2026-10-29)
