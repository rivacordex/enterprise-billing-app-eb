import type postgresjs from "postgres";

// rpt04-spec Tests — the Part B fixture (plan §B.3): a RAN usage rate card
// `CARD_X` with V1 (activated 20261001, superseded by V2), V2 (activated
// 20261025, ACTIVE) and V3 (DRAFT), named by one offering's `usage_rate` price
// (rpt04 D2), plus a per-unit `usage_rate` price that names no card (ignored).
// Seeded with plain SQL as the superuser: Product owns these tables and the
// report only reads them. The offerings stay DRAFT, so the DRAFT-guard trigger
// never fires on the price inserts.
//
// The capacity values come from the fixture capacity source
// (tests/fixtures/reporting/polygon_capacity/capacity.csv) until P1.

export const CARD_X = "CARD_X";

// The file for the default report date, 20261026 (V2): P-T1, P-T3 (ends on
// D), PAAA_02 (starts on D), P-T13's rounding and the P-T11 sort (MNO1 <
// MNO10 < MNO2). Excluded: P-T2 (ended), P-T4 (future), P-T6 (DRAFT) and the
// three skipped rows (SKIPPED_20261026).
export const EXPECTED_20261026 = [
  "MNO1,AAA,PAAA_01,20261026,20260101,MNO1_DISTRICT-001,SVCCODE0001,1000",
  "MNO1,AAA,PAAA_02,20261026,20261026,MNO1_DISTRICT-002,SVCCODE0002,1001",
  "MNO1,AAA,PAAA_03,20261026,20260201,MNO1_DISTRICT-003,SVCCODE0003,1000",
  "MNO1,BBB,PEND_26,20261026,20260101,MNO1_DISTRICT-005,SVCCODE0005,250",
  "MNO10,AAA,P10_01,20261026,20260301,MNO10_DISTRICT-010,SVCCODE0010,10",
]
  .map((line) => line + "\n")
  .join("");

export const SKIPPED_20261026 = [
  "SKIPPED MNO2|CCC|PNOCAP CAPACITY_MISSING",
  "SKIPPED MNO2|CCC|PNODIST DISTRICT_MISSING",
  "SKIPPED MNO2|CCC|PNOSVC SERVICE_CODE_MISSING",
];

interface LkpRow {
  mno: string;
  cu: string;
  polygon: string;
  start: string; // YYYY-MM-DD
  end?: string | null;
  district: string | null;
  serviceCode: string | null;
}

// V2 — the version in force on the default report date, 20261026.
export const V2_ROWS: LkpRow[] = [
  // P-T1 — the normal row; P-T13 1000.49 → 1000.
  {
    mno: "MNO1",
    cu: "AAA",
    polygon: "PAAA_01",
    start: "2026-01-01",
    district: "DISTRICT-001",
    serviceCode: "SVCCODE0001",
  },
  // P-T13 1000.50 → 1001; starts on the report date itself (still valid).
  {
    mno: "MNO1",
    cu: "AAA",
    polygon: "PAAA_02",
    start: "2026-10-26",
    district: "DISTRICT-002",
    serviceCode: "SVCCODE0002",
  },
  // P-T13 999.50 → 1000.
  {
    mno: "MNO1",
    cu: "AAA",
    polygon: "PAAA_03",
    start: "2026-02-01",
    district: "DISTRICT-003",
    serviceCode: "SVCCODE0003",
  },
  // P-T2 — ended 20261025: excluded.
  {
    mno: "MNO1",
    cu: "BBB",
    polygon: "PEND_25",
    start: "2026-01-01",
    end: "2026-10-25",
    district: "DISTRICT-004",
    serviceCode: "SVCCODE0004",
  },
  // P-T3 — ends 20261026: included.
  {
    mno: "MNO1",
    cu: "BBB",
    polygon: "PEND_26",
    start: "2026-01-01",
    end: "2026-10-26",
    district: "DISTRICT-005",
    serviceCode: "SVCCODE0005",
  },
  // P-T4 — starts 20261027: excluded.
  {
    mno: "MNO1",
    cu: "BBB",
    polygon: "PSTART_27",
    start: "2026-10-27",
    district: "DISTRICT-006",
    serviceCode: "SVCCODE0006",
  },
  // P-T11 — sorted by code point: MNO1 < MNO10 < MNO2.
  {
    mno: "MNO10",
    cu: "AAA",
    polygon: "P10_01",
    start: "2026-03-01",
    district: "DISTRICT-010",
    serviceCode: "SVCCODE0010",
  },
  // P-T7 — blank district / blank service code: skipped.
  {
    mno: "MNO2",
    cu: "CCC",
    polygon: "PNODIST",
    start: "2026-01-01",
    district: null,
    serviceCode: "SVCCODE0021",
  },
  {
    mno: "MNO2",
    cu: "CCC",
    polygon: "PNOSVC",
    start: "2026-01-01",
    district: "DISTRICT-022",
    serviceCode: " ",
  },
  // R04-T4 — the fixture source has no capacity for it: skipped.
  {
    mno: "MNO2",
    cu: "CCC",
    polygon: "PNOCAP",
    start: "2026-01-01",
    district: "DISTRICT-023",
    serviceCode: "SVCCODE0023",
  },
];

// V1 — in force 20261001 … 20261024 (P-T5).
export const V1_ROWS: LkpRow[] = [
  {
    mno: "MNO1",
    cu: "AAA",
    polygon: "PAAA_01",
    start: "2026-01-01",
    district: "DISTRICT-001",
    serviceCode: "SVCCODE0001",
  },
  {
    mno: "MNO1",
    cu: "AAA",
    polygon: "PV1_ONLY",
    start: "2026-01-01",
    district: "DISTRICT-099",
    serviceCode: "SVCCODE0099",
  },
];

// V3 — DRAFT, never used (P-T6).
export const V3_ROWS: LkpRow[] = [
  {
    mno: "MNO9",
    cu: "ZZZ",
    polygon: "PDRAFT",
    start: "2026-01-01",
    district: "DISTRICT-900",
    serviceCode: "SVCCODE0900",
  },
];

export interface PolygonCapacityFixture {
  offeringId: string; // the offering whose usage_rate price names CARD_X
  versions: { v1: string; v2: string; v3: string };
}

export async function insertLkpRows(
  sql: postgresjs.Sql,
  versionId: string,
  rows: LkpRow[],
): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await sql`
      INSERT INTO product.ratecard_ran_usage_lkp
        (ratecard_version_id, mno_public_key, commercial_unit_public_key,
         polygon_id, polygon_start_date, polygon_end_date, state, district,
         lkp_subscriber_ref_id, service_code)
      VALUES (${versionId}, ${r.mno}, ${r.cu}, ${r.polygon}, ${r.start},
              ${r.end ?? null}, 'STATE-1', ${r.district},
              ${`PRDINV${String(i).padStart(8, "0")}`}, ${r.serviceCode})`;
  }
}

export async function insertVersion(
  sql: postgresjs.Sql,
  card: string,
  versionNum: number,
  status: string,
  activatedAt: string | null,
  rows: LkpRow[],
): Promise<string> {
  const [v] = await sql<{ id: string }[]>`
    INSERT INTO product.ratecard_version
      (card_name, version_num, status, snapshot_date, source_file, row_count,
       activated_at)
    VALUES (${card}, ${versionNum}, ${status}, '2026-10-01',
            ${`rpt04-${card}-v${versionNum}.csv`}, ${rows.length},
            ${activatedAt})
    RETURNING ratecard_version_id AS id`;
  await insertLkpRows(sql, v!.id, rows);
  return v!.id;
}

export async function insertOffering(
  sql: postgresjs.Sql,
  name: string,
): Promise<string> {
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO product.product_offering
      (name, is_bundle, is_sellable, billing_only)
    VALUES (${name}, false, true, false)
    RETURNING product_offering_id AS id`;
  return o!.id;
}

// A `usage_rate` price; `card` null is a per-unit price naming no card.
export async function insertUsagePrice(
  sql: postgresjs.Sql,
  offeringId: string,
  card: string | null,
  startDateTime: string,
): Promise<string> {
  const params: Record<string, string> = { ratePerUnit: "0" };
  if (card !== null) params.rateCardLookUp = card;
  const component = {
    "@type": "usage_rate",
    plaSpecId: card === null ? null : "PLA_USAGE_RATE",
    params,
  };
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO product.product_offering_price
      (product_offering_id, name, component_type, price_component,
       unit_of_measure, currency, start_date_time)
    VALUES (${offeringId}, 'RAN usage', 'usage_rate', ${sql.json(component)},
            'Mbps', 'MYR', ${startDateTime})
    RETURNING product_offering_price_id AS id`;
  return p!.id;
}

export async function seedPolygonCapacityFixture(
  sql: postgresjs.Sql,
): Promise<PolygonCapacityFixture> {
  const offeringId = await insertOffering(sql, "rpt04 RAN usage");
  // Named from 20260901 (so 20260831 names no card — R04-T3).
  await insertUsagePrice(sql, offeringId, CARD_X, "2026-09-01T00:00:00+08:00");
  // A per-unit usage_rate price on another offering names no card: ignored.
  const perUnit = await insertOffering(sql, "rpt04 per-unit usage");
  await insertUsagePrice(sql, perUnit, null, "2026-09-01T00:00:00+08:00");

  const v1 = await insertVersion(
    sql,
    CARD_X,
    1,
    "SUPERSEDED",
    "2026-10-01T09:00:00+08:00",
    V1_ROWS,
  );
  const v2 = await insertVersion(
    sql,
    CARD_X,
    2,
    "ACTIVE",
    "2026-10-25T10:00:00+08:00",
    V2_ROWS,
  );
  const v3 = await insertVersion(sql, CARD_X, 3, "DRAFT", null, V3_ROWS);
  await sql`
    UPDATE product.ratecard_version SET superseded_by_version_id = ${v2}
    WHERE ratecard_version_id = ${v1}`;
  return { offeringId, versions: { v1, v2, v3 } };
}
