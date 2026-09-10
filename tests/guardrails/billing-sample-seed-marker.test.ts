import { describe, expect, it } from "vitest";

import {
  SAMPLE_UDR_SOURCE_FILE,
  buildSampleUdrRatedRow,
  type SampleChargeSpec,
} from "@/db/seeds/sample/udr-rated-sample";

// bm21-spec §Implementation §1, code-standards §9 item 16 — "Placeholder
// isolation, phase-2 additions (bm15): while BILLRUN_PLACEHOLDER_MODE is
// set, every run is badged [already asserted per-page, e.g.
// tests/app/bill-runs-page.test.tsx] AND seeded udr_rated is
// `_SAMPLE_*`-marked". The badge half already had page-level coverage; this
// closes the second half, which had none — a pure, DB-free assertion against
// the D28 stand-in factory `buildSampleUdrRatedRow` (db/seeds/sample/
// udr-rated-sample.ts) that `db:seed-sample` uses to build every unclaimed
// `rating.udr_rated` charge it seeds. Never a live-DB round trip: the
// factory is a pure function, and the marker is a property of its OUTPUT
// SHAPE, not of anything only Postgres could tell us.
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

  it("every seeded row starts unclaimed — no bill-run reference until a real run claims it", () => {
    const row = buildSampleUdrRatedRow(BASE_SPEC);
    expect(row.billrunRefId).toBeNull();
    expect(row.billrunAttempt).toBeNull();
    expect(row.billrunChecksum).toBeNull();
    expect(row.billrunBanId).toBe(BASE_SPEC.ban);
  });
});
