import { describe, expect, it } from "vitest";

import {
  SAMPLE_UDR_SOURCE_FILE,
  buildSampleUdrRatedRow,
  type SampleChargeSpec,
} from "@/db/seeds/sample/udr-rated-sample";

// bm21-spec §Implementation §1, code-standards §9 item 16 (rescoped phase 3 by
// bm33 D31) — seed provenance. The former "badge half" is GONE:
// `BILLRUN_PLACEHOLDER_MODE` and the per-page placeholder-badge assertions were
// retired by bm33 (the flag's copy is false once the real flow deploys). What
// survives, and what this asserts, is the seed-provenance half: every seeded
// `rating.udr_rated` row is `_SAMPLE_*`-marked. A pure, DB-free assertion
// against the D28 stand-in factory `buildSampleUdrRatedRow` (db/seeds/sample/
// udr-rated-sample.ts) that `db:seed-sample` uses to build every unclaimed
// charge it seeds. Never a live-DB round trip: the factory is a pure function,
// and the marker is a property of its OUTPUT SHAPE, not of anything only
// Postgres could tell us.
const SAMPLE_MARKER = /^_SAMPLE_/;

const BASE_SPEC: SampleChargeSpec = {
  ban: "BAN00000001",
  subscriberRefId: "PIV00000001",
  priceRef: "OPP00000001",
  startDatetime: new Date("2026-06-01T00:00:00.000Z"),
  endDatetime: new Date("2026-07-01T00:00:00.000Z"),
  ratedPrice: "199.00",
  currency: "MYR",
  sequence: 1,
};

describe("db:seed-sample marks every seeded udr_rated row _SAMPLE_* (bm15-spec §Implementation §2, bm21-spec §Implementation §1)", () => {
  it("SAMPLE_UDR_SOURCE_FILE itself carries the _SAMPLE_ prefix", () => {
    expect(SAMPLE_UDR_SOURCE_FILE).toMatch(SAMPLE_MARKER);
  });

  it("a default (RATED) row is marked on udrSourceFile/udrRefBatchId/ratingEngineVersion", () => {
    const row = buildSampleUdrRatedRow(BASE_SPEC);
    expect(row.status).toBe("RATED");
    expect(row.udrSourceFile).toMatch(SAMPLE_MARKER);
    expect(row.udrRefBatchId).toMatch(SAMPLE_MARKER);
    expect(row.ratingEngineVersion).toMatch(SAMPLE_MARKER);
  });

  it("a default row is RAN_USAGE — the only udr_type udr_rated carries into billing (bm26-spec §Implementation §1, Inv #1)", () => {
    const row = buildSampleUdrRatedRow(BASE_SPEC);
    // Recurring is bm29 compute from product_inventory, never rated —
    // SUBSCRIPTION_RECURRING is retired from the factory. This is byte-for-byte
    // the udr_type rl.py's build_chunk_rows copies through for usage.
    expect(row.udrType).toBe("RAN_USAGE");
  });

  it("a BILL_NOTUSED row (bm15-spec's second seeded pair) is marked the same way", () => {
    const row = buildSampleUdrRatedRow({
      ...BASE_SPEC,
      status: "BILL_NOTUSED",
    });
    expect(row.status).toBe("BILL_NOTUSED");
    expect(row.udrSourceFile).toMatch(SAMPLE_MARKER);
    expect(row.udrRefBatchId).toMatch(SAMPLE_MARKER);
    expect(row.ratingEngineVersion).toMatch(SAMPLE_MARKER);
  });

  it("every seeded row starts unclaimed AND unattributed — all four billrun_* columns NULL (bm26-spec §Implementation §1, matching rl.py)", () => {
    const row = buildSampleUdrRatedRow(BASE_SPEC);
    // bm26 flip: billrun_ban_id is now NULL too (was the account id under
    // bm15). rl.py's build_chunk_rows writes NONE of the four billrun_*
    // columns; a freshly loaded usage row is unclaimed AND unattributed. This
    // is the single change that unblocks bm27 Collection — a row Collection can
    // resolve is one that does not already carry its account.
    expect(row.billrunBanId).toBeNull();
    expect(row.billrunRefId).toBeNull();
    expect(row.billrunAttempt).toBeNull();
    expect(row.billrunChecksum).toBeNull();
  });

  it("a BILL_NOTUSED row is equally unclaimed — all four billrun_* columns NULL", () => {
    const row = buildSampleUdrRatedRow({
      ...BASE_SPEC,
      status: "BILL_NOTUSED",
    });
    expect(row.billrunBanId).toBeNull();
    expect(row.billrunRefId).toBeNull();
    expect(row.billrunAttempt).toBeNull();
    expect(row.billrunChecksum).toBeNull();
  });
});
