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
  CHECKSUM_ALGORITHMS,
  InvoiceRenderError,
  type ChecksumAlgorithm,
  type InvoiceProfile,
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

function isChecksumAlgorithm(value: string): value is ChecksumAlgorithm {
  return (CHECKSUM_ALGORITHMS as readonly string[]).includes(value);
}

// D4 — blob-only half: fetch the logo bytes, verify them against the row's
// checksum (code-standards General rule 8 — no byte is used unverified), and
// inline them as a `data:` URI so the render makes zero network requests. A
// profile without a logo keeps `logoUrl: null` (the header hides it; no throw).
export async function inlineLogo({
  profile,
  logo,
}: ReadInvoiceProfileResult): Promise<InvoiceProfile> {
  if (!logo) return profile;

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
