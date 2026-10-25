import type postgresjs from "postgres";

// bm74 (`0053`, Inv #65) — a non-default invoice template type for the DB
// suites. Since 0053 a type carries its own `layout_code`, and a settings
// (generated) version must point at a layout of the SAME type
// (`btv_pair_same_type_fk`), so a second type can no longer borrow Standard's
// layout `BTV00000001`. This inserts the type plus its own ACTIVE layout v1,
// which reuses Standard v1's stored, checksum-verified files (blob_ref,
// checksum, page_setup), so anything rendered from it matches Standard v1.
// Returns the layout version id for the type's generated fixtures.
export async function insertTemplateTypeFixture(
  sql: postgresjs.Sql,
  opts: {
    typeId: string;
    code: string;
    name: string;
    layoutVersionId: string;
  },
): Promise<string> {
  const layoutCode = `INVTPL-${opts.code}`;
  await sql`
    INSERT INTO billing.bill_template_family
      (bill_template_family_id, code, name, layout_code, kind)
    VALUES (${opts.typeId}, ${opts.code}, ${opts.name}, ${layoutCode}, 'generated')`;
  await sql`
    INSERT INTO billing.bill_template_version
      (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
       ref_bill_template_family_id, layout_code, page_setup, blob_ref, checksum,
       checksum_algorithm, change_note, activated_datetime)
    SELECT ${opts.layoutVersionId}, 'INVOICE', 'layout', 1, 'ACTIVE', false,
           ${opts.typeId}, ${layoutCode}, page_setup, blob_ref, checksum,
           checksum_algorithm, 'bm74 type layout fixture', now()
    FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000001'`;
  return opts.layoutVersionId;
}
