-- ac01: pgledger double-entry ledger fork, vendored into `billing` via
-- db/pgledger/transform.ts (module invariant #14 -- never hand-edited; see
-- db/pgledger/README.md for the upgrade procedure). The ULID-helper and
-- pgledger sections below are copied in verbatim from db/pgledger/ulid.sql
-- and db/pgledger/billing-pgledger.generated.sql -- never re-typed.
--
-- No CREATE EXTENSION: neither pgledger.sql nor the vendored ULID helper
-- call anything outside pg_catalog -- gen_random_uuid(), uuid_send(),
-- GET_BYTE(), CHR() are all core Postgres (ac01-spec Sec.2.5 / Sec.4:
-- "confirm which ULID implementation is vendored before assuming").
CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ULID helper (db/pgledger/ulid.sql) -- must precede pgledger below because
-- pgledger id column defaults call billing.uuid_to_ulid().
-- ---------------------------------------------------------------------------

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

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- pgledger fork (db/pgledger/billing-pgledger.generated.sql)
-- ---------------------------------------------------------------------------

-- GENERATED by db/pgledger/transform.ts from pgledger.sql @ 43240dbdfc291eca5380cbcee7dfe594922c67d6 — DO NOT EDIT
-- Regenerate with: npm run pgledger:transform

-- uuidv7 is a new function in PostgreSQL 18:
-- https://www.postgresql.org/docs/release/18.0/
CREATE FUNCTION billing.pgledger_uuidv7_exists() RETURNS BOOL
AS $$
    SELECT EXISTS(SELECT * FROM pg_proc WHERE proname = 'uuidv7');
$$ LANGUAGE sql IMMUTABLE SET search_path = billing, pg_catalog;
--> statement-breakpoint

-- Function to generate uuidv7 at microsecond precision. It's not monotonic,
-- but hopefully close enough at microsecond precision.
--   From: https://postgresql.verite.pro/blog/2024/07/15/uuid-v7-pure-sql.html
-- This will only be used in PostgreSQL versions below 18 when the builtin
-- uuidv7() function does not exist (which is monotonic).
CREATE FUNCTION billing.pgledger_uuidv7_microsecond() RETURNS UUID
AS $$
    select encode(
        substring(int8send(floor(t_ms)::int8) from 3) ||
        int2send((7<<12)::int2 | ((t_ms-floor(t_ms))*4096)::int2) ||
        substring(uuid_send(gen_random_uuid()) from 9 for 8)
        , 'hex')::uuid
    from (select extract(epoch from clock_timestamp())*1000 as t_ms) s
$$ LANGUAGE sql VOLATILE SET search_path = billing, pg_catalog;
--> statement-breakpoint

CREATE FUNCTION billing.pgledger_uuidv7() RETURNS UUID
AS $$
DECLARE
    result uuid;
BEGIN
    IF billing.pgledger_uuidv7_exists() THEN
        EXECUTE 'select uuidv7()' INTO result;
        RETURN result;
    ELSE
        RETURN billing.pgledger_uuidv7_microsecond();
    END IF;
end
$$ LANGUAGE plpgsql VOLATILE SET search_path = billing, pg_catalog;
--> statement-breakpoint

CREATE FUNCTION billing.pgledger_generate_id(prefix TEXT) RETURNS TEXT
AS $$
    SELECT prefix || '_' || billing.uuid_to_ulid(billing.pgledger_uuidv7())
$$ LANGUAGE sql VOLATILE SET search_path = billing, pg_catalog;
--> statement-breakpoint

CREATE TABLE billing.pgledger_accounts (
    id TEXT PRIMARY KEY DEFAULT billing.pgledger_generate_id('pgla'),
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    balance NUMERIC NOT NULL DEFAULT 0,
    version BIGINT NOT NULL DEFAULT 0,
    allow_negative_balance BOOLEAN NOT NULL,
    allow_positive_balance BOOLEAN NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint

CREATE TABLE billing.pgledger_transfers (
    id TEXT PRIMARY KEY DEFAULT billing.pgledger_generate_id('pglt'),
    from_account_id TEXT NOT NULL REFERENCES billing.pgledger_accounts (id),
    to_account_id TEXT NOT NULL REFERENCES billing.pgledger_accounts (id),
    amount NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    metadata JSONB,
    CHECK (amount > 0 AND from_account_id != to_account_id)
);
--> statement-breakpoint

CREATE INDEX ON billing.pgledger_transfers (from_account_id);
--> statement-breakpoint

CREATE INDEX ON billing.pgledger_transfers (to_account_id);
--> statement-breakpoint

CREATE INDEX ON billing.pgledger_transfers (event_at);
--> statement-breakpoint

CREATE TABLE billing.pgledger_entries (
    id TEXT PRIMARY KEY DEFAULT billing.pgledger_generate_id('pgle'),
    account_id TEXT NOT NULL REFERENCES billing.pgledger_accounts (id),
    transfer_id TEXT NOT NULL REFERENCES billing.pgledger_transfers (id),
    amount NUMERIC NOT NULL,
    account_previous_balance NUMERIC NOT NULL,
    account_current_balance NUMERIC NOT NULL,
    account_version BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint

CREATE INDEX ON billing.pgledger_entries (account_id);
--> statement-breakpoint

CREATE INDEX ON billing.pgledger_entries (transfer_id);
--> statement-breakpoint

CREATE VIEW billing.pgledger_accounts_view AS
SELECT
    id,
    name,
    currency,
    balance,
    version,
    allow_negative_balance,
    allow_positive_balance,
    metadata,
    created_at,
    updated_at
FROM billing.pgledger_accounts;
--> statement-breakpoint

CREATE VIEW billing.pgledger_transfers_view AS
SELECT
    id,
    from_account_id,
    to_account_id,
    amount,
    created_at,
    event_at,
    metadata
FROM billing.pgledger_transfers;
--> statement-breakpoint

CREATE VIEW billing.pgledger_entries_view AS
SELECT
    e.id,
    e.account_id,
    e.transfer_id,
    e.amount,
    e.account_previous_balance,
    e.account_current_balance,
    e.account_version,
    e.created_at,
    t.event_at,
    t.metadata
FROM billing.pgledger_entries e
INNER JOIN billing.pgledger_transfers t ON e.transfer_id = t.id;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing.pgledger_create_account(
    name TEXT,
    currency TEXT,
    allow_negative_balance BOOLEAN DEFAULT TRUE,
    allow_positive_balance BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT NULL
)
RETURNS SETOF billing.PGLEDGER_ACCOUNTS_VIEW
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO billing.pgledger_accounts (name, currency, allow_negative_balance, allow_positive_balance, metadata, created_at, updated_at)
    VALUES (name, currency, allow_negative_balance, allow_positive_balance, metadata, now(), now())
    RETURNING *;
END;
$$ LANGUAGE plpgsql SET search_path = billing, pg_catalog;
--> statement-breakpoint

-- Helper function to check account balance constraints
CREATE OR REPLACE FUNCTION billing.pgledger_check_account_balance_constraints(account billing.PGLEDGER_ACCOUNTS) RETURNS VOID AS $$
BEGIN
    -- If account doesn't allow negative balance and balance is negative, raise an error
    IF NOT account.allow_negative_balance AND (account.balance < 0) THEN
        RAISE EXCEPTION 'Account (id=%, name=%) does not allow negative balance', account.id, account.name;
    END IF;

    -- If account doesn't allow positive balance and balance is positive, raise an error
    IF NOT account.allow_positive_balance AND (account.balance > 0) THEN
        RAISE EXCEPTION 'Account (id=%, name=%) does not allow positive balance', account.id, account.name;
    END IF;
END;
$$ LANGUAGE plpgsql SET search_path = billing, pg_catalog;
--> statement-breakpoint

-- Define a composite type for transfer requests
CREATE TYPE billing.transfer_request AS (
    from_account_id TEXT,
    to_account_id TEXT,
    amount NUMERIC
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing.pgledger_create_transfer(
    from_account_id TEXT,
    to_account_id TEXT,
    amount NUMERIC,
    event_at TIMESTAMPTZ DEFAULT NULL,
    metadata JSONB DEFAULT NULL
)
RETURNS SETOF billing.PGLEDGER_TRANSFERS_VIEW
AS $$
BEGIN
    -- Simply call pgledger_create_transfers with a single transfer
    RETURN QUERY
    SELECT * FROM billing.pgledger_create_transfers(
        transfer_requests => array[(from_account_id, to_account_id, amount)::billing.transfer_request],
        event_at => event_at,
        metadata => metadata
    );
END;
$$ LANGUAGE plpgsql SET search_path = billing, pg_catalog;
--> statement-breakpoint

-- Function to create multiple transfers in a single transaction without an event_at
CREATE OR REPLACE FUNCTION billing.pgledger_create_transfers(VARIADIC transfer_requests billing.transfer_request [])
RETURNS SETOF billing.PGLEDGER_TRANSFERS_VIEW
AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM billing.pgledger_create_transfers(transfer_requests);
END;
$$ LANGUAGE plpgsql SET search_path = billing, pg_catalog;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing.pgledger_create_transfers(
    transfer_requests billing.transfer_request [],
    event_at TIMESTAMPTZ DEFAULT NULL,
    metadata JSONB DEFAULT NULL
)
RETURNS SETOF billing.PGLEDGER_TRANSFERS_VIEW
AS $$
DECLARE
    transfer_request billing.transfer_request;
    transfer_ids TEXT[] := '{}';
    transfer_id TEXT;
    from_account billing.pgledger_accounts;
    to_account billing.pgledger_accounts;
    from_account_id TEXT;
    to_account_id TEXT;
    all_account_ids TEXT[] := '{}';
BEGIN
    -- Collect all unique account IDs and sort them to prevent deadlocks
    FOREACH transfer_request IN ARRAY transfer_requests LOOP
        all_account_ids := array_append(all_account_ids, transfer_request.from_account_id);
        all_account_ids := array_append(all_account_ids, transfer_request.to_account_id);
    END LOOP;

    -- Remove duplicates and sort
    SELECT ARRAY(SELECT DISTINCT unnest FROM unnest(all_account_ids) ORDER BY unnest)
    INTO all_account_ids;

    -- Lock all accounts in order
    FOREACH from_account_id IN ARRAY all_account_ids LOOP
        PERFORM billing.pgledger_accounts.id
        FROM billing.pgledger_accounts
        WHERE billing.pgledger_accounts.id = from_account_id
        FOR UPDATE;
    END LOOP;

    -- Process each transfer
    FOREACH transfer_request IN ARRAY transfer_requests LOOP
        -- Preliminary checks
        IF transfer_request.amount <= 0 THEN
            RAISE EXCEPTION 'Amount (%) must be positive', transfer_request.amount;
        END IF;

        IF transfer_request.from_account_id = transfer_request.to_account_id THEN
            RAISE EXCEPTION 'Cannot transfer to the same account (id=%)', transfer_request.from_account_id;
        END IF;

        -- Update account balances
        UPDATE billing.pgledger_accounts
        SET balance = balance - transfer_request.amount,
            version = version + 1,
            updated_at = now()
        WHERE billing.pgledger_accounts.id = transfer_request.from_account_id
        RETURNING * INTO from_account;

        -- Check balance constraints for the source account
        PERFORM billing.pgledger_check_account_balance_constraints(from_account);

        UPDATE billing.pgledger_accounts
        SET balance = balance + transfer_request.amount,
            version = version + 1,
            updated_at = now()
        WHERE billing.pgledger_accounts.id = transfer_request.to_account_id
        RETURNING * INTO to_account;

        -- Check balance constraints for the destination account
        PERFORM billing.pgledger_check_account_balance_constraints(to_account);

        -- Check that currencies match
        IF from_account.currency != to_account.currency THEN
            RAISE EXCEPTION 'Cannot transfer between different currencies (% and %)', from_account.currency, to_account.currency;
        END IF;

        -- Create transfer record
        INSERT INTO billing.pgledger_transfers (from_account_id, to_account_id, amount, created_at, event_at, metadata)
        VALUES (transfer_request.from_account_id, transfer_request.to_account_id, transfer_request.amount, now(), coalesce(event_at, now()), metadata)
        RETURNING billing.pgledger_transfers.id INTO transfer_id;

        transfer_ids := array_append(transfer_ids, transfer_id);

        -- Create entry for the source account (negative amount)
        INSERT INTO billing.pgledger_entries (account_id, transfer_id, amount, account_previous_balance, account_current_balance, account_version, created_at)
        VALUES (transfer_request.from_account_id, transfer_id, -transfer_request.amount, from_account.balance + transfer_request.amount, from_account.balance, from_account.version, now());

        -- Create entry for the destination account (positive amount)
        INSERT INTO billing.pgledger_entries (account_id, transfer_id, amount, account_previous_balance, account_current_balance, account_version, created_at)
        VALUES (transfer_request.to_account_id, transfer_id, transfer_request.amount, to_account.balance - transfer_request.amount, to_account.balance, to_account.version, now());
    END LOOP;

    -- Return all created transfers
    RETURN QUERY
    SELECT *
    FROM billing.pgledger_transfers_view
    WHERE id = ANY(transfer_ids)
    ORDER BY id;
END;
$$ LANGUAGE plpgsql SET search_path = billing, pg_catalog;
