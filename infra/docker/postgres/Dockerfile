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
FROM postgres:17-bookworm

# postgresql-$PG_MAJOR-{cron,partman} resolve against PG_MAJOR, set by the base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       "postgresql-${PG_MAJOR}-cron" \
       "postgresql-${PG_MAJOR}-partman" \
  && rm -rf /var/lib/apt/lists/*

# pg_cron must be loaded at server start (shared_preload_libraries is static), and
# its scheduler must target the database where `CREATE EXTENSION pg_cron` runs —
# audit-partman-setup.sql creates it in the app DB, so point cron.database_name
# there. Both are baked as CMD flags (overridable via the compose `command:` if
# POSTGRES_DB differs); the default matches the compose POSTGRES_DB.
CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=enterprise_billing"]
