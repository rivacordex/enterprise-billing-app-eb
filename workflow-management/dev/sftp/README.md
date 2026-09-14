# `dev/sftp/` — local SFTP distribution endpoint (bm22 §7)

The local stand-in for the real SFTP delivery target. `bill_run_distribution`
(bm34) uploads each rendered invoice PDF + the run report here via
`io.kestra.plugin.fs.sftp.Upload`. **bm22 only stands this endpoint up** —
distribution is still the loopback placeholder, so nothing connects to it yet.

Brought up by the `sftp` service in
`workflow-management/dev/docker-compose.dev.yml` (`atmoz/sftp:alpine`), reachable
on `localhost:${SFTP_HOST_PORT:-2222}` from the host as user `billrun`,
**key-auth only**. The engine reaches it in-network as `sftp:22`.

## Layout & chroot

- `keys/` — drop your dev **public** key(s) here (`*.pub`). atmoz installs every
  `*.pub` into `billrun`'s `authorized_keys` at container start. **Gitignored**
  — only `.gitkeep` is committed. The matching **private** key stays on your
  host (and, for bm34, goes into a Kestra Secret from Key Vault) — never here,
  never committed.
- `init/00-init-dirs.sh` — mounted into `/etc/sftp.d/`; atmoz runs it once at
  start to seed the `invoices/` + `reports/` subtree and chown it to `billrun`.
- **Delivered artifacts live in the `sftp_upload` named volume**, not on the
  host (a host bind mount is not chowned by atmoz and is unwritable by the
  chrooted uid-1001 user on Linux). Inspect with:
  `docker compose ... exec sftp ls -R /home/billrun/upload`.
- **Chroot / remote base:** atmoz chroots `billrun` to `/home/billrun`, so the
  server dir `/home/billrun/upload` is addressable **by the client as `/upload`**
  — that is `SFTP_REMOTE_BASE`. The delivered tree (architecture §3):
  - `/upload/invoices/{YYYY-MM}/{INV}.pdf`
  - `/upload/reports/{YYYY-MM}/{bill_run_id}-report.csv`

## One-time local setup

Nothing in this repo is a real credential — the dev keypair is a throwaway you
generate locally. This keeps the (open-source) repo publish-safe.

```bash
# 1. Generate a throwaway dev keypair (do NOT reuse a personal key)
ssh-keygen -t ed25519 -N '' -C 'billrun-dev-sftp' \
  -f workflow-management/dev/sftp/keys/billrun_dev
#    -> keys/billrun_dev (private, gitignored) + keys/billrun_dev.pub (installed)

# 2. Bring the stack up (the sftp service reads keys/*.pub at start)
docker compose -f docker-compose.dev.yml \
  -f workflow-management/dev/docker-compose.dev.yml up -d sftp

# 3. Capture the server host key for client-side host-key verification (bm34).
#    Host keys regenerate on each container recreate (they are deliberately not
#    persisted — a persisted host key would be a committed private key), so
#    re-run this after a `--build`/recreate. SFTP_HOST_PORT is the HOST port
#    (default 2222) — set it in your shell/project .env if you changed it.
ssh-keyscan -p "${SFTP_HOST_PORT:-2222}" -t ed25519 localhost > /tmp/sftp_known_hosts

# 4. Smoke it — put/verify/remove against /upload (no password prompt)
printf 'put %s /upload/invoices/2026-09/test.pdf\nls -l /upload/invoices/2026-09\nrm /upload/invoices/2026-09/test.pdf\n' \
  workflow-management/dev/sftp/keys/billrun_dev.pub > /tmp/sftp_batch
sftp -P "${SFTP_HOST_PORT:-2222}" \
  -i workflow-management/dev/sftp/keys/billrun_dev \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/sftp_known_hosts \
  -b /tmp/sftp_batch billrun@localhost
```

> The same put→verify→remove round-trip (key-auth + host-key verification +
> md5 integrity) was validated against a throwaway ephemeral SFTP server during
> bm22 — see `billmgmt-progress-tracker.md`.

## Env surface

`SFTP_HOST` / `SFTP_PORT` / `SFTP_USER` / `SFTP_REMOTE_BASE` are consumed by the
workflow **engine/flows** (bm34), never by the app:

- **Local dev** — `workflow-management/dev/.env.example` (in-network `sftp:22`,
  `SFTP_REMOTE_BASE=/upload`); the private key + known_hosts go in
  `SECRET_SFTP_PRIVATE_KEY` / `SECRET_SFTP_KNOWN_HOSTS` (base64, left unset —
  machine-local material you set after keygen).
- **Deployed** — wired in
  `infra/bicep/modules/workflow-engine-container-app.bicep` behind
  `enableSftpDistribution` (default off): non-secret coordinates as env, the
  key + known_hosts as Key Vault → Kestra Secret with host-key verification on.
  **Not** in `infra/env/*.template` (those are app-container env; the engine is a
  separate Container App). The repo-root `.env.example` lists the vars only as
  inventory (the app does not read them).
