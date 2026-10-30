# `dev/outbound/` — local reporting outbound folder (rpt01)

The local stand-in for the reporting outbound shares (rpt01 D7, RF8). Bound
into the `workflow-engine` service at `/data/outbound`
(`workflow-management/dev/docker-compose.dev.yml`). Deployed, each destination
is its **own** Azure Files share on a separate storage account
(`infra/bicep/modules/reporting-outbound-storage.bicep`), mounted at
`/data/outbound/<destination>/`; locally this one folder holds them all.

Each destination has its own subfolder, named by its flow's `outbound_dir`
variable and committed here (a `.gitkeep`): the runtime never creates it, as a
missing deployed share must fail the run (`OUTBOUND_DIR_NOT_MOUNTED`). Files
arrive by write-then-rename (`.<name>.tmp` → `<name>`), and a
delivered file is never overwritten.

| Subfolder | Flow | Readers |
| --- | --- | --- |
| `_platform-check/` | `report-platform-check` | none (health check) |

The audience of every destination is recorded in
`workflow-management/flows/reporting/README.md` (_Outbound destinations_).

**Gitignored** (by the `.gitignore` in this folder) — only this README and the
`.gitignore` and each destination's `.gitkeep` are committed; delivered files
are runtime output, not source.
