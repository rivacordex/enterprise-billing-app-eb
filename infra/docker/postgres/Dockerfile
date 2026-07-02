# Custom PostgreSQL image with pg_partman + pg_cron baked in — for LOCAL dev/test
# parity with the Azure Flexible Server config (infra/bicep/modules/postgres.bicep:
# azure.extensions = PG_PARTMAN,PG_CRON,PGCRYPTO; shared_preload_libraries = pg_cron).
#
# pgcrypto ships with the official image (postgresql-contrib). pg_partman and
# pg_cron are installed from the PGDG apt repo the official postgres image already
# has configured. PGDG ships pg_partman v5.x for PG 17 — matching the named-
# parameter create_parent() signature in db/bootstrap/audit-partman-setup.sql
# (a v4.x image would need the 'native' p_type signature instead).
#
# Alpine is intentionally NOT used: pg_partman/pg_cron aren't packaged there and
# would have to be compiled by hand. Debian bookworm gets them straight from apt.
# Digest pinned to postgres:17-bookworm for reproducible builds (re-resolve
# periodically via `docker pull postgres:17-bookworm` to pick up patches).
FROM postgres:17-bookworm@sha256:17b6c778de50f4bb9a878c36e736110fbcd9b7020377d6fdfdf20f7c0347e40a

# postgresql-$PG_MAJOR-{cron,partman} resolve against PG_MAJOR, set by the base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       "postgresql-${PG_MAJOR}-cron" \
       "postgresql-${PG_MAJOR}-partman" \
  && rm -rf /var/lib/apt/lists/*

# Run as the non-root `postgres` account (uid 999) the base image already creates,
# so the container never ends as root (SAST: dockerfile.security.missing-user).
# The base entrypoint normally starts as root only to chown the data dir and then
# drops to `postgres` via gosu; pinning USER here skips that root phase. It's safe
# because the compose stack uses named volumes, which inherit the image's postgres
# ownership at /var/lib/postgresql/data — no root-time chown needed. (A host bind
# mount would need matching ownership on the host side instead.)
USER postgres

# pg_cron must be loaded at server start (shared_preload_libraries is static), and
# its scheduler must target the database where `CREATE EXTENSION pg_cron` runs —
# audit-partman-setup.sql creates it in the app DB, so point cron.database_name
# there. Both are baked as CMD flags (overridable via the compose `command:` if
# POSTGRES_DB differs); the default matches the compose POSTGRES_DB.
CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=enterprise_billing"]
