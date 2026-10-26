// cm23 (custmgmt Inv. #21, #22; code-standards §10 General rules 4–5) — the
// customer-screen label for a BAN's invoice template type: the type and the
// version the next bill run will capture. Computed live per request, never
// cached or stored. Reads Billing's repositories only; never calls
// resolveTemplate, resolveVersionsForPosting or resolveCurrentVersionsForFamily.
//
//   NULL (Standard)  → STANDARD    "Standard (default) · v{N}" (findActive ?? findDefault)
//   usable type      → TYPE        "{name} · v{N}" (its ACTIVE settings version)
//   retired, or no ACTIVE settings (SQL bypass only)
//                    → NOT_USABLE  "{name} · not usable"

import type { Database } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { STANDARD_TYPE_NAME } from "@/types/accounts";
import type { BanTemplateLabel } from "@/types/accounts";

// One read per distinct value: callers pass every BAN's type id (duplicates
// and nulls included) once per request and look each BAN up in the map.
export async function resolveBanTemplateLabels(
  db: Database,
  typeIds: (string | null)[],
): Promise<Map<string | null, BanTemplateLabel>> {
  const entries = await Promise.all(
    [...new Set(typeIds)].map(
      async (typeId): Promise<[string | null, BanTemplateLabel]> => [
        typeId,
        typeId === null ? await standardLabel(db) : await typeLabel(db, typeId),
      ],
    ),
  );
  return new Map(entries);
}

// The label of one BAN from the map `resolveBanTemplateLabels` built over the
// same request's BANs.
export function templateLabelFor(
  labels: Map<string | null, BanTemplateLabel>,
  typeId: string | null,
): BanTemplateLabel {
  const label = labels.get(typeId);
  if (label === undefined) throw new Error(`no template label for ${typeId}`);
  return label;
}

// Standard is found by lookup (`findDefault`), never by id (General rule 1).
// A missing Standard row or version (impossible after 0046) still renders.
async function standardLabel(db: Database): Promise<BanTemplateLabel> {
  const standard = await billTemplateFamilyRepository.findDefault(db);
  const version =
    standard === null
      ? null
      : ((await billTemplateVersionRepository.findActive(db, {
          kind: "generated",
          familyId: standard.billTemplateFamilyId,
        })) ??
        (await billTemplateVersionRepository.findDefault(db, {
          kind: "generated",
          familyId: standard.billTemplateFamilyId,
        })));
  if (version === null) {
    return {
      kind: "STANDARD",
      text: STANDARD_TYPE_NAME,
      name: STANDARD_TYPE_NAME,
      versionNo: null,
    };
  }
  return {
    kind: "STANDARD",
    text: `${STANDARD_TYPE_NAME} · v${version.versionNo}`,
    name: STANDARD_TYPE_NAME,
    versionNo: version.versionNo,
  };
}

async function typeLabel(
  db: Database,
  typeId: string,
): Promise<BanTemplateLabel> {
  const [type, active] = await Promise.all([
    billTemplateFamilyRepository.findById(db, typeId),
    billTemplateVersionRepository.findActive(db, {
      kind: "generated",
      familyId: typeId,
    }),
  ]);
  const name = type?.name ?? typeId;
  if (type === null || type.retiredDatetime !== null || active === null) {
    return {
      kind: "NOT_USABLE",
      text: `${name} · not usable`,
      name,
      versionNo: null,
    };
  }
  return {
    kind: "TYPE",
    text: `${name} · v${active.versionNo}`,
    name,
    versionNo: active.versionNo,
  };
}
