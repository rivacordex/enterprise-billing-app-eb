import type postgresjs from "postgres";

// cm23 — raw-SQL template type fixtures for the Customer Management bind suites
// (same convention as invoice-template-types-catalog.integration.test.ts). A
// type is usable when it is not retired and has an ACTIVE `generated`
// (settings) version; `withActiveSettings: false` leaves it with only a layout
// row, i.e. not yet usable. Ids are explicit so suites can name them.

const STRUCTURE = JSON.stringify({
  sections: { payment: true },
  columns: {},
  footnote: ["Calculations are done in Mbps"],
});

export interface TemplateTypeFixture {
  typeId: string;
  code: string;
  name: string;
  // The fixture's version-id prefix: layout `${n}1`, settings `${n}2`.
  versionSeed: number;
  withActiveSettings: boolean;
}

export async function insertTemplateType(
  sql: postgresjs.Sql,
  fx: TemplateTypeFixture,
): Promise<void> {
  const layoutCode = `INVTPL-${fx.code}`;
  const layoutId = `BTV${String(fx.versionSeed * 10 + 1).padStart(8, "0")}`;
  const settingsId = `BTV${String(fx.versionSeed * 10 + 2).padStart(8, "0")}`;
  await sql`
    INSERT INTO billing.bill_template_family
      (bill_template_family_id, code, name, layout_code, kind)
    VALUES (${fx.typeId}, ${fx.code}, ${fx.name}, ${layoutCode}, 'generated')`;
  await sql`
    INSERT INTO billing.bill_template_version
      (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
       ref_bill_template_family_id, layout_code, page_setup, blob_ref, checksum,
       checksum_algorithm, change_note, activated_datetime)
    VALUES
      (${layoutId}, 'INVOICE', 'layout', 1, 'ACTIVE', ${fx.typeId}, ${layoutCode},
       '{}'::jsonb, ${`invoice-templates/layouts/${layoutCode}/v1/`},
       ${"a".repeat(64)}, 'sha256', 'test row', now())`;
  if (!fx.withActiveSettings) return;
  await sql`
    INSERT INTO billing.bill_template_version
      (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
       ref_bill_template_family_id, ref_layout_version_id, structure, blob_ref, checksum,
       checksum_algorithm, change_note, activated_datetime)
    VALUES
      (${settingsId}, 'INVOICE', 'generated', 1, 'ACTIVE', ${fx.typeId}, ${layoutId},
       ${STRUCTURE}::jsonb, ${`invoice-templates/generated/INVOICE/${fx.code}/v1/`},
       ${"b".repeat(64)}, 'sha256', 'test row', now())`;
}

// Retirement is the one update `bill_template_family_guard` allows.
export async function retireTemplateType(
  sql: postgresjs.Sql,
  typeId: string,
): Promise<void> {
  await sql`
    UPDATE billing.bill_template_family SET retired_datetime = now()
    WHERE bill_template_family_id = ${typeId}`;
}
