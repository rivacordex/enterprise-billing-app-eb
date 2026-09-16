# `dev/distribution/` — local loopback distribution sink (bm34)

The local stand-in for the deployed billrun engine's mounted distribution share.
`bill_run_distribution`'s `loopback` target (the default) writes delivered
artifacts here via `io.kestra.plugin.fs.local.Upload` — **no SFTP, no keys**, the
bytes land straight on this bind mount so you can inspect them on the host.

Bound into the `workflow-engine` service at `/distribution`
(`workflow-management/dev/docker-compose.dev.yml`); `kestra.yml`'s
`io.kestra.plugin.fs.local` `allowed-paths` lists `/distribution`, so the plugin
is permitted to write here.

Layout (architecture §3 — separate subtrees, different audiences):

- `/distribution/invoices/{YYYY-MM}/{INV}.pdf`
- `/distribution/reports/{YYYY-MM}/{bill_run_id}-report.csv`

**Gitignored** — only `.gitkeep` + this README are committed; delivered artifacts
are runtime output, not source. The deployed equivalent is an Azure Files share
mounted on the billrun engine, provisioned by the `enableLocalDistributionSink`
path in `infra/bicep/modules/workflow-engine-container-app.bicep`.

The real external `sftp` target (a downstream endpoint) is enabled separately via
the app's `BILLRUN_DISTRIBUTION_TARGETS=sftp` + the engine's
`enableSftpDistribution` (see `../sftp/README.md`); it does NOT write here.
