import { readFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { blobStore } from "@/services/billing/blob-store";
import {
  decodeUtf8,
  detectImageType,
  imageDimensions,
} from "@/services/billing/invoice-profile/image-dimensions";
import { DraftConflict } from "@/services/billing/invoice-profile/draft-conflict";
import { findSvgViolation } from "@/services/billing/invoice-profile/sanitize-logo";
import { getBrandingLogo } from "@/services/system-config/app-config-read.service";
import {
  LOGO_MAX_BYTES,
  LOGO_MIME_TYPES,
  LOGO_MIN_SIDE_PX,
  type LogoMimeType,
  type LogoRejectDetail,
  type LogoRejectReason,
} from "@/types/billing";

// bm60-spec §Design D2/D5/D6 (Inv #44/#45/#48): validate an uploaded logo
// server-side, store it write-once at a content-addressed path in
// `invoice-assets`, and point the working DRAFT profile at the new version.
// The client's `File.size`/`File.type` never decide anything: the declared
// type only seeds the MIME comparison (check 2).

export type LogoCheckResult =
  | {
      ok: true;
      mime: LogoMimeType;
      ext: "png" | "jpg" | "svg";
      width: number;
      height: number;
    }
  | {
      ok: false;
      code: "LOGO_REJECTED";
      reason: LogoRejectReason;
      detail: LogoRejectDetail;
    };

export type UploadLogoResult =
  | {
      ok: true;
      assetVersionId: string;
      versionNo: number;
      draftVersion: number;
      draftToken: string;
    }
  | Extract<LogoCheckResult, { ok: false }>
  | { ok: false; code: "DRAFT_CONFLICT" | "ACTIVATION_BLOB_CONFLICT" };

const EXTENSIONS: Record<LogoMimeType, "png" | "jpg" | "svg"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const INT4_MAX = 2_147_483_647;

function reject(
  reason: LogoRejectReason,
  detail: LogoRejectDetail,
): Extract<LogoCheckResult, { ok: false }> {
  return { ok: false, code: "LOGO_REJECTED", reason, detail };
}

export function isLogoMimeType(value: string): value is LogoMimeType {
  return (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

// D2 — the four checks in data rule 9 order; the first failure rejects.
// Pure: no I/O, nothing written.
export function checkLogo(
  bytes: Buffer,
  declaredMime: string,
): LogoCheckResult {
  // 1 — size, on the actual byte length.
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
    return reject("size", { byteSize: bytes.length, maxBytes: LOGO_MAX_BYTES });
  }
  // 2 — the magic bytes decide the type; it must equal the declared MIME.
  const detected = detectImageType(bytes);
  if (!isLogoMimeType(declaredMime) || detected !== declaredMime) {
    return reject("mime", { declared: declaredMime, detected });
  }
  // 3 — dimensions; the shorter side ≥ 300 px.
  const dims = imageDimensions(detected, bytes);
  if (!dims.ok) {
    return reject(dims.reason, { message: dims.message });
  }
  if (
    Math.min(dims.width, dims.height) < LOGO_MIN_SIDE_PX ||
    // `bill_asset_version.width/height` are int4: a larger (or infinite SVG)
    // size is rejected here, not as an insert failure after the blob write.
    Math.max(dims.width, dims.height) > INT4_MAX
  ) {
    return reject("dimensions", {
      width: dims.width,
      height: dims.height,
      minSidePx: LOGO_MIN_SIDE_PX,
    });
  }
  // 4 — the SVG content policy (reject, never repair).
  if (detected === "image/svg+xml") {
    const construct = findSvgViolation(decodeUtf8(bytes) ?? "");
    if (construct !== null) return reject("svg_content", { construct });
  }
  return {
    ok: true,
    mime: detected,
    ext: EXTENSIONS[detected],
    width: dims.width,
    height: dims.height,
  };
}

export async function uploadLogo(
  input: { bytes: Buffer; declaredMime: string; expectedDraftToken: string },
  actorId: string,
): Promise<UploadLogoResult> {
  const checked = checkLogo(input.bytes, input.declaredMime);
  if (!checked.ok) return checked;

  // Fail fast before a blob write when the draft is already gone or stale
  // (the transaction below re-checks under the lock).
  const draft = await invoiceProfileRepository.findDraftVersion(db);
  if (draft?.token !== input.expectedDraftToken) {
    return { ok: false, code: "DRAFT_CONFLICT" };
  }

  // D5 step 1–2.
  const digest = blobStore.digest(input.bytes, "sha256");
  const asset = await db.transaction((tx) =>
    billAssetRepository.ensureLogoAsset(tx, actorId),
  );

  // D5 step 3 — write-once at a content-addressed path: the same bytes find
  // the same blob, different bytes get a new path. A different blob at the
  // path is a conflict (bm58's code). Orphans are never deleted inline.
  const put = await blobStore.putObject(
    "invoice-assets",
    `${asset.billAssetId}/sha256-${digest.slice(0, 12)}/logo.${checked.ext}`,
    input.bytes,
    checked.mime,
    {
      writeOnce: true,
      onExists: "returnExisting",
      checksumAlgorithm: "sha256",
    },
  );
  if (put.checksum !== digest) {
    return { ok: false, code: "ACTIVATION_BLOB_CONFLICT" };
  }

  // D5 step 4 — one transaction: version row → draft pointer → audit.
  const outcome = await db
    .transaction(async (tx) => {
      const version = await billAssetRepository.insertVersion(tx, {
        assetId: asset.billAssetId,
        mime: checked.mime,
        width: checked.width,
        height: checked.height,
        byteSize: input.bytes.length,
        blobRef: put.blobRef,
        checksum: digest,
        actor: actorId,
      });
      const pointed = await invoiceProfileRepository.setDraftLogo(tx, {
        expectedDraftToken: input.expectedDraftToken,
        assetVersionId: version.billAssetVersionId,
        actor: actorId,
      });
      // Roll the version row back with the conflict: nothing points at it.
      if (pointed === null) throw new DraftConflict();

      await insertAuditEvent(tx, {
        eventType: "INVOICE_LOGO_UPLOADED",
        actorUserId: actorId,
        targetEntity: "BILL_ASSET_VERSION",
        targetId: version.billAssetVersionId,
        beforeData: {
          previousDraftLogoAssetVersionId: pointed.previousLogoAssetVersionId,
        },
        afterData: {
          assetId: asset.billAssetId,
          assetVersionId: version.billAssetVersionId,
          versionNo: version.versionNo,
          mime: version.mime,
          width: version.width,
          height: version.height,
          byteSize: version.byteSize,
          checksum: version.checksum,
          profileDraftVersion: pointed.configVersion,
        },
      });
      return {
        ok: true as const,
        assetVersionId: version.billAssetVersionId,
        versionNo: version.versionNo,
        draftVersion: pointed.configVersion,
        draftToken: pointed.token,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof DraftConflict) {
        return { ok: false as const, code: "DRAFT_CONFLICT" as const };
      }
      throw error;
    });
  return outcome;
}

const APP_LOGO_TYPES: Record<string, LogoMimeType> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// D8 — the optional first-setup import of the app's branding logo. The path
// comes from `getBrandingLogo()` (its resolver restricts it to `/brand/`), is
// re-checked to stay under `public/brand/`, and the bytes then run the SAME
// D2–D6 pipeline, so the import can be rejected like any upload. The app
// branding logo itself is only read.
export async function importAppLogo(
  expectedDraftToken: string,
  actorId: string,
): Promise<UploadLogoResult | { ok: false; code: "APP_LOGO_UNAVAILABLE" }> {
  const branding = await getBrandingLogo();
  const src = branding?.src ?? "/brand/invoice-logo-default.svg";
  const brandDir = path.join(process.cwd(), "public", "brand");
  const file = path.resolve(path.join(process.cwd(), "public", src));
  const declaredMime = APP_LOGO_TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(brandDir + path.sep) || declaredMime === undefined) {
    return { ok: false, code: "APP_LOGO_UNAVAILABLE" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return { ok: false, code: "APP_LOGO_UNAVAILABLE" };
  }
  return uploadLogo({ bytes, declaredMime, expectedDraftToken }, actorId);
}
