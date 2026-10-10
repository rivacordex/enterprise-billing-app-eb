import type { Database } from "@/db/client";
import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import type { BillAssetVersion } from "@/db/schema/billing/bill-asset";
import { COUNTRY_LABELS, MYINVOIS_STATE_LABELS } from "@/lib/myinvois-states";
import { blobStore } from "@/services/billing/blob-store";
import {
  invoiceProfileSchema,
  toInvoiceProfileInput,
} from "@/validation/billing/invoice-profile.schema";
import {
  InvoiceRenderError,
  isChecksumAlgorithm,
  type CompanyProfilePageModel,
  type InvoiceProfile,
  type ProfileHistoryRow,
} from "@/types/billing";

// bm53-spec §Design D3/D4 — the company-profile read. Nothing here is cached
// (code-standards Part 2 data rule 8: the one sanctioned cache holds compiled
// templates only — never a profile or a logo).
//
// The read is split in two so the binder can read rows inside its read-only
// transaction and do the logo's blob I/O after that transaction closes (D5
// step 4): `readInvoiceProfile` (DB only) → `inlineLogo` (blob only).
// `getInvoiceProfile` composes both for callers without that constraint.

// D3 — parse one version's rows into the typed profile. A failure is the typed
// `INVOICE_PROFILE_INVALID`, never a partial profile (TS rule 5).
export function parseInvoiceProfile(
  configVersion: number,
  rows: Readonly<Record<string, string | null>>,
): InvoiceProfile {
  const parsed = invoiceProfileSchema.safeParse(toInvoiceProfileInput(rows));
  if (!parsed.success) {
    throw new InvoiceRenderError(
      "INVOICE_PROFILE_INVALID",
      `invoice.profile version ${configVersion} failed validation`,
      {
        configVersion,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      },
    );
  }
  const p = parsed.data;
  return {
    configVersion,
    company: {
      name: p.company_name,
      registrationNo: p.registration_no,
      tin: p.tin,
      sstRegNo: p.sst_reg_no ?? null,
      addressLine1: p.address_line1,
      addressLine2: p.address_line2 ?? null,
      postcode: p.postcode,
      city: p.city,
      stateCode: p.state_code,
      // The schema bounds the code to 01–16, so the lookup always hits.
      state: MYINVOIS_STATE_LABELS[p.state_code] ?? p.state_code,
      countryCode: p.country_code,
      country: COUNTRY_LABELS[p.country_code] ?? p.country_code,
      phone: p.phone,
      email: p.email,
      website: p.website ?? null,
      brandColor: p.brand_color,
      accentColor: p.accent_color,
      logoUrl: null,
    },
    payment: {
      bankName: p.bank_name,
      accountName: p.bank_account_name,
      accountNo: p.bank_account_no,
      swift: p.swift,
      jomPayBillerCode: p.jompay_biller_code ?? null,
      remittanceEmail: p.remittance_email,
    },
    paymentTermsDays: p.payment_terms_days,
    logoAssetVersionId: p.logo_asset_version_id ?? null,
  };
}

export interface ReadInvoiceProfileResult {
  profile: InvoiceProfile;
  // The logo's asset-version row, or `null` when the profile has no logo.
  logo: BillAssetVersion | null;
}

// DB-only half: the version's rows + the logo's asset-version row.
export async function readInvoiceProfile(
  db: Database,
  configVersion: number,
): Promise<ReadInvoiceProfileResult> {
  const rows = await invoiceProfileRepository.readVersion(db, configVersion);
  const profile = parseInvoiceProfile(configVersion, rows);
  if (profile.logoAssetVersionId === null) return { profile, logo: null };

  const logo = await billAssetRepository.findVersionById(
    db,
    profile.logoAssetVersionId,
  );
  if (!logo) {
    throw new InvoiceRenderError(
      "INVOICE_PROFILE_INVALID",
      `invoice.profile version ${configVersion} references unknown logo ${profile.logoAssetVersionId}`,
      { configVersion, logoAssetVersionId: profile.logoAssetVersionId },
    );
  }
  return { profile, logo };
}

// Fetch a logo's bytes and verify them against the row's checksum
// (code-standards General rule 8 — no byte is used unverified; Inv #45). A
// mismatch, or a checksum algorithm the store does not know, throws
// `ASSET_CHECKSUM_MISMATCH`. Shared by the render path (`inlineLogo`) and the
// GET handler (`getVerifiedLogo`).
async function fetchVerifiedLogoBytes(logo: BillAssetVersion): Promise<Buffer> {
  const { container, path } = blobStore.parseBlobRef(logo.blobRef);
  const bytes = await blobStore.getObject(container, path);
  if (
    !isChecksumAlgorithm(logo.checksumAlgorithm) ||
    blobStore.digest(bytes, logo.checksumAlgorithm) !== logo.checksum
  ) {
    throw new InvoiceRenderError(
      "ASSET_CHECKSUM_MISMATCH",
      `logo ${logo.billAssetVersionId} does not match its recorded checksum`,
      { assetVersionId: logo.billAssetVersionId },
    );
  }
  return bytes;
}

// D4 — blob-only half: fetch the verified logo bytes and
// inline them as a `data:` URI so the render makes zero network requests. A
// profile without a logo keeps `logoUrl: null` (the header hides it; no throw).
export async function inlineLogo({
  profile,
  logo,
}: ReadInvoiceProfileResult): Promise<InvoiceProfile> {
  if (!logo) return profile;

  const bytes = await fetchVerifiedLogoBytes(logo);
  return {
    ...profile,
    company: {
      ...profile.company,
      logoUrl: `data:${logo.mime};base64,${bytes.toString("base64")}`,
    },
  };
}

// D3 — `getInvoiceProfile(db, version)`: the parsed profile with its verified,
// inlined logo.
export async function getInvoiceProfile(
  db: Database,
  configVersion: number,
): Promise<InvoiceProfile> {
  return inlineLogo(await readInvoiceProfile(db, configVersion));
}

// bm56 D2 — parse a `meta.*` ISO-8601 value; unset or unparseable → `null`.
function metaDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// bm56 D1/D2 — the Company profile page's view-model. Shown version:
// `?version=` when it names a stored version (a DRAFT only for EDIT users),
// else the ACTIVE version, else the DRAFT (EDIT users), else `null` (the
// empty state, G15 A). Nothing is cached.
export async function getCompanyProfilePageModel(
  db: Database,
  { version, canEdit }: { version?: number | undefined; canEdit: boolean },
): Promise<CompanyProfilePageModel> {
  const all = await invoiceProfileRepository.listVersions(db);
  // A DRAFT is invisible to READ users, in the history as well as the form.
  const visible = canEdit ? all : all.filter((v) => v.status !== "DRAFT");

  const requested =
    version === undefined
      ? undefined
      : visible.find((v) => v.configVersion === version);
  const chosen =
    requested ??
    visible.find((v) => v.status === "ACTIVE") ??
    visible.find((v) => v.status === "DRAFT");

  const userIds = new Set<string>();
  for (const v of visible) {
    if (v.modifiedBy) userIds.add(v.modifiedBy);
    const activator = v.meta["meta.activated_by"];
    if (chosen?.configVersion === v.configVersion && activator) {
      userIds.add(activator);
    }
  }
  const names = await invoiceProfileRepository.resolveUserNames(db, [
    ...userIds,
  ]);

  const history: ProfileHistoryRow[] = visible.map((v) => ({
    versionNo: v.configVersion,
    status: v.status,
    createdBy: v.modifiedBy ? (names.get(v.modifiedBy) ?? v.modifiedBy) : null,
    createdAt: v.createdDatetime,
    activatedAt: metaDate(v.meta["meta.activated_at"]),
    retiredAt: metaDate(v.meta["meta.retired_at"]),
    changeNote: v.meta["meta.change_note"] ?? null,
    usedByCount: v.usedByCount,
  }));

  if (!chosen) return { shown: null, history };

  const raw = await invoiceProfileRepository.readVersionRaw(
    db,
    chosen.configVersion,
  );
  const activator = raw.meta["meta.activated_by"];
  return {
    shown: {
      version: chosen.configVersion,
      status: chosen.status,
      fields: raw.fields,
      meta: raw.meta,
      activatedByName: activator ? (names.get(activator) ?? activator) : null,
      logoAssetVersionId: raw.fields.logo_asset_version_id ?? null,
    },
    history,
  };
}

export interface VerifiedLogo {
  bytes: Buffer;
  mime: string;
}

// bm56 D3 — the logo bytes for the GET handler: the asset-version row, the
// blob, and a digest check against the row\'s checksum before one byte is
// returned (Inv #45). Unknown id → `null` (404). A mismatch throws
// `ASSET_CHECKSUM_MISMATCH` and serves nothing.
export async function getVerifiedLogo(
  db: Database,
  assetVersionId: string,
): Promise<VerifiedLogo | null> {
  const logo = await billAssetRepository.findVersionById(db, assetVersionId);
  if (!logo) return null;

  return { bytes: await fetchVerifiedLogoBytes(logo), mime: logo.mime };
}
