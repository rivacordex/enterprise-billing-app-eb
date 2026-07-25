-- Vendored from: https://github.com/scoville/pgsql-ulid (BSD-3-Clause,
-- Copyright (c) 2021, Scoville), via pgledger's own vendored copy at
-- https://github.com/pgr0ss/pgledger/blob/main/vendor/scoville-pgsql-ulid/uuid-to-ulid.sql
-- (pinned to the pgledger commit recorded in UPSTREAM_COMMIT, since pgledger
-- vendors this file itself rather than depending on it externally).
--
-- Only the uuid -> ULID direction (`format_ulid` + `uuid_to_ulid`) is
-- vendored: pgledger.sql's `pgledger_generate_id(prefix)` calls
-- `uuid_to_ulid(pgledger_uuidv7())` to build its `pgla_…`/`pglt_…`/`pgle_…`
-- ids, but nothing in pgledger.sql calls the reverse `ulid_to_uuid`, so that
-- half of the upstream helper is not vendored (no dead SQL).
--
-- Qualified into `billing` (function names + the internal `format_ulid`
-- call site) and given the same `SET search_path = billing, pg_catalog`
-- pgledger.sql's own functions get, consistent with module invariant #14
-- ("nothing pgledger touches escapes the module schema"). Body logic is
-- otherwise byte-identical to upstream — no behavioural change.
--
-- This file is loaded before billing-pgledger.generated.sql in the
-- migration (db/migrations/0011_billing_pgledger.sql), because
-- pgledger's id column defaults call billing.uuid_to_ulid(...).

CREATE OR REPLACE FUNCTION billing.format_ulid(bytes bytea) RETURNS text AS $$
DECLARE
  encoding   bytea = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  output     text  = '';
BEGIN

  -- Encode the timestamp
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 0) & 224) >> 5));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 0) & 31)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 1) & 248) >> 3));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 1) & 7) << 2) | ((GET_BYTE(bytes, 2) & 192) >> 6)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 2) & 62) >> 1));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 2) & 1) << 4) | ((GET_BYTE(bytes, 3) & 240) >> 4)));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 3) & 15) << 1) | ((GET_BYTE(bytes, 4) & 128) >> 7)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 4) & 124) >> 2));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 4) & 3) << 3) | ((GET_BYTE(bytes, 5) & 224) >> 5)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 5) & 31)));

  -- Encode the entropy
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 6) & 248) >> 3));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 6) & 7) << 2) | ((GET_BYTE(bytes, 7) & 192) >> 6)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 7) & 62) >> 1));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 7) & 1) << 4) | ((GET_BYTE(bytes, 8) & 240) >> 4)));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 8) & 15) << 1) | ((GET_BYTE(bytes, 9) & 128) >> 7)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 9) & 124) >> 2));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 9) & 3) << 3) | ((GET_BYTE(bytes, 10) & 224) >> 5)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 10) & 31)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 11) & 248) >> 3));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 11) & 7) << 2) | ((GET_BYTE(bytes, 12) & 192) >> 6)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 12) & 62) >> 1));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 12) & 1) << 4) | ((GET_BYTE(bytes, 13) & 240) >> 4)));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 13) & 15) << 1) | ((GET_BYTE(bytes, 14) & 128) >> 7)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 14) & 124) >> 2));
  output = output || CHR(GET_BYTE(encoding, ((GET_BYTE(bytes, 14) & 3) << 3) | ((GET_BYTE(bytes, 15) & 224) >> 5)));
  output = output || CHR(GET_BYTE(encoding, (GET_BYTE(bytes, 15) & 31)));

  RETURN output;
END
$$
LANGUAGE plpgsql
IMMUTABLE
SET search_path = billing, pg_catalog;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing.uuid_to_ulid(id uuid) RETURNS text AS $$
BEGIN
    RETURN billing.format_ulid(uuid_send(id));
END
$$
LANGUAGE plpgsql
IMMUTABLE
SET search_path = billing, pg_catalog;
