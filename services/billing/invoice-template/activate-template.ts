import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import {
  loadLayout,
  PROBE_RENDER_INPUT,
} from "@/services/billing/invoice-template/load";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";
import {
  InvoiceRenderError,
  type InvoiceErrorCode,
  type InvoiceRenderInput,
  type TemplateActivationErrorCode,
  type TemplateDraftErrorCode,
} from "@/types/billing";
import {
  activateTemplateInputSchema,
  type ActivateTemplateInput,
} from "@/validation/billing/activate-version.schema";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm58-spec §Design D2 (Inv #41/#42/#44/#45/#46/#49, General rule 10): activate
// the saved working DRAFT. All-or-nothing, in this order, and the previous
// ACTIVE version is untouched by every failure:
//
//   2. read the draft (no lock), token + status, re-parse its structure
//   3. load the layout (checksum-verified)
//   4. generate invoice.hbs / footer.hbs / structure.json
//   5. test-render both in a fresh compile against the layout's sample bill
//   6. build checksums.json; the directory is content-addressed
//   7. write the four files write-once (blob store)
//   8. ONE transaction: lock, re-read the draft FOR UPDATE, retire the previous
//      non-default ACTIVE, promote the draft, audit
//
// Steps 3-7 run outside any database transaction. A failure in step 8 rolls it
// back and leaves the step-7 blobs as harmless orphans: they are write-once and
// never deleted inline (workflow rules §6.7), and the content-addressed path
// makes an identical retry find identical bytes instead of colliding.

// Render failures the caller can act on, returned as result codes; anything
// else is a real fault and propagates. One tuple feeds both the runtime guard
// and the result type, so they cannot drift.
const RETURNED_RENDER_CODES = [
  "TEMPLATE_CHECKSUM_MISMATCH",
  "TEMPLATE_VERSION_NOT_FOUND",
  "TEMPLATE_GENERATION_FAILED",
  "TEMPLATE_COMPILE_FAILED",
  "MANDATORY_SECTION_HIDDEN",
] as const satisfies readonly InvoiceErrorCode[];
type ReturnedRenderCode = (typeof RETURNED_RENDER_CODES)[number];

function isReturnedRenderCode(
  code: InvoiceErrorCode,
): code is ReturnedRenderCode {
  return (RETURNED_RENDER_CODES as readonly InvoiceErrorCode[]).includes(code);
}

export type ActivateTemplateErrorCode =
  | TemplateActivationErrorCode
  | TemplateDraftErrorCode
  | ReturnedRenderCode
  | "VALIDATION_ERROR";

export type ActivateTemplateResult =
  | {
      ok: true;
      versionId: string;
      versionNo: number;
      retiredVersionId: string | null;
      blobRef: string;
      checksum: string;
    }
  | { ok: false; code: ActivateTemplateErrorCode };

const CONTAINER = "invoice-templates" as const;

const CONTENT_TYPES = {
  "invoice.hbs": "text/x-handlebars-template; charset=utf-8",
  "footer.hbs": "text/x-handlebars-template; charset=utf-8",
  "structure.json": "application/json",
  "checksums.json": "application/json",
} as const;

// Thrown inside the step-8 transaction to roll it back, then mapped to a result
// outside (a returned value would COMMIT the retirement).
class ActivationRollback extends Error {
  constructor(readonly code: "DRAFT_CONFLICT") {
    super(code);
  }
}

// The blob store's one checksum function, not a second implementation.
function sha256(bytes: Buffer): string {
  return blobStore.digest(bytes, "sha256");
}

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// bm50 D3 canonical form: sorted keys, 2-space indent, LF, trailing newline.
function buildChecksumIndex(files: ReadonlyMap<string, Buffer>): Buffer {
  const index = { algorithm: "sha256", files: {} as Record<string, string> };
  for (const [name, bytes] of [...files].sort(([a], [b]) =>
    byCodePoint(a, b),
  )) {
    index.files[name] = sha256(bytes);
  }
  return Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

function testRenderFailed(message: string): InvoiceRenderError {
  return new InvoiceRenderError("TEMPLATE_COMPILE_FAILED", message, {
    stage: "test-render",
  });
}

// Step 5: compile both outputs fresh (never the memo) and execute them against
// (a) the layout's verified sample bill as a draft, as issued, and with no
// company or payment profile (the G15 path), and (b) the SAME typed
// `PROBE_RENDER_INPUT` that `loadGenerated` executes when it first loads the
// version. Both gates must agree: a template that passed activation but failed
// the load probe would already be ACTIVE (and the previous version RETIRED)
// while every render of it parked. Handlebars compiles lazily, so executing is
// what surfaces an unknown helper or a strict-mode missing path.
export function testRender(
  invoiceHbs: string,
  footerHbs: string,
  sample: InvoiceRenderInput,
): void {
  const invoice = compileInvoiceTemplate(invoiceHbs);
  const footer = compileInvoiceTemplate(footerHbs);

  const probe = PROBE_RENDER_INPUT;
  const variants: InvoiceRenderInput[] = [
    { ...probe, isDraft: true, invoice: { ...probe.invoice, isDraft: true } },
    { ...probe, isDraft: false, invoice: { ...probe.invoice, isDraft: false } },
    { ...probe, company: null, payment: null },
    { ...sample, isDraft: true, invoice: { ...sample.invoice, isDraft: true } },
    {
      ...sample,
      isDraft: false,
      invoice: { ...sample.invoice, isDraft: false },
    },
    {
      ...sample,
      isDraft: false,
      invoice: { ...sample.invoice, isDraft: false },
      company: null,
      payment: null,
    },
  ];

  for (const input of variants) {
    const html = executeInvoiceTemplate(invoice, input);
    if (html.trim() === "")
      throw testRenderFailed("invoice.hbs rendered empty");
    if (html.includes("[[") || html.includes("]]")) {
      throw testRenderFailed(
        "invoice.hbs rendered an unresolved [[ ]] directive",
      );
    }
    const footerHtml = executeInvoiceTemplate(footer, input);
    if (footerHtml.trim() === "")
      throw testRenderFailed("footer.hbs rendered empty");
    if (
      !footerHtml.includes("pageNumber") ||
      !footerHtml.includes("totalPages")
    ) {
      throw testRenderFailed(
        "footer.hbs must carry the pageNumber and totalPages spans",
      );
    }
  }
}

export async function activateTemplate(
  rawInput: ActivateTemplateInput,
  actorId: string,
): Promise<ActivateTemplateResult> {
  // Step 1 (defense in depth; the action parsed already).
  const parsed = activateTemplateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const noteMissing = parsed.error.issues.some(
      (i) => i.message === "CHANGE_NOTE_REQUIRED",
    );
    return {
      ok: false,
      code: noteMissing ? "CHANGE_NOTE_REQUIRED" : "VALIDATION_ERROR",
    };
  }
  const { draftId, expectedDraftToken, changeNote } = parsed.data;

  // Step 2: the draft, as the form last saw it.
  const draft = await billTemplateVersionRepository.findDraft(db, {
    kind: "generated",
  });
  if (
    !draft ||
    draft.billTemplateVersionId !== draftId ||
    draft.token !== expectedDraftToken
  ) {
    return { ok: false, code: "DRAFT_CONFLICT" };
  }
  const structure = invoiceTemplateStructureSchema.safeParse(draft.structure);
  if (!structure.success) {
    // Only the mandatory-section rule is "a required section is hidden"; any
    // other schema failure (an unknown key, a missing column key, a wrong type)
    // is an invalid stored structure and must not be reported as that.
    const hidden = structure.error.issues.some(
      (i) => i.message === "MANDATORY_SECTION_HIDDEN",
    );
    return {
      ok: false,
      code: hidden ? "MANDATORY_SECTION_HIDDEN" : "VALIDATION_ERROR",
    };
  }
  if (draft.refLayoutVersionId === null) {
    return { ok: false, code: "TEMPLATE_VERSION_NOT_FOUND" };
  }

  let files: Map<string, Buffer>;
  let dir: string;
  let indexDigest: string;
  try {
    // Step 3: the layout, checksum-verified.
    const layoutRow = await billTemplateVersionRepository.findById(
      db,
      draft.refLayoutVersionId,
    );
    if (!layoutRow) return { ok: false, code: "TEMPLATE_VERSION_NOT_FOUND" };
    const layoutFiles = await loadLayout(layoutRow);

    // Step 4: generate.
    const generated = generate(
      layoutFilesFromVerified(layoutFiles),
      structure.data,
    );

    // Step 5: test-render.
    testRender(
      generated.invoiceHbs,
      generated.footerHbs,
      parseSampleData(layoutFiles),
    );

    // Step 6: checksums and the content-addressed directory.
    files = new Map<string, Buffer>([
      ["invoice.hbs", Buffer.from(generated.invoiceHbs, "utf-8")],
      ["footer.hbs", Buffer.from(generated.footerHbs, "utf-8")],
      ["structure.json", Buffer.from(generated.structureJson, "utf-8")],
    ]);
    const indexBytes = buildChecksumIndex(files);
    files.set("checksums.json", indexBytes);
    indexDigest = sha256(indexBytes);
    dir = `generated/INVOICE/v${draft.versionNo}-${indexDigest.slice(0, 12)}`;
  } catch (error) {
    if (
      error instanceof InvoiceRenderError &&
      isReturnedRenderCode(error.code)
    ) {
      return { ok: false, code: error.code };
    }
    throw error;
  }

  // Step 7: write-once. An existing blob with the same bytes is fine (an
  // identical retry); different bytes at the same path abort the activation.
  for (const [name, bytes] of files) {
    const put = await blobStore.putObject(
      CONTAINER,
      `${dir}/${name}`,
      bytes,
      CONTENT_TYPES[name as keyof typeof CONTENT_TYPES],
      {
        writeOnce: true,
        onExists: "returnExisting",
        checksumAlgorithm: "sha256",
      },
    );
    if (put.checksum !== sha256(bytes)) {
      return { ok: false, code: "ACTIVATION_BLOB_CONFLICT" };
    }
  }

  // Step 8: one transaction. Retire BEFORE promote (`btv_one_active_uq`).
  const blobRef = `${CONTAINER}/${dir}/`;
  try {
    return await db.transaction(async (tx): Promise<ActivateTemplateResult> => {
      await billTemplateVersionRepository.lockKind(tx, { kind: "generated" });

      const locked = await billTemplateVersionRepository.findDraftForUpdate(
        tx,
        draftId,
      );
      if (!locked || locked.token !== expectedDraftToken) {
        throw new ActivationRollback("DRAFT_CONFLICT");
      }

      const retired = await billTemplateVersionRepository.retireActive(tx, {
        kind: "generated",
      });
      const previous =
        retired ??
        (await billTemplateVersionRepository.findDefault(tx, {
          kind: "generated",
        }));

      const promoted = await billTemplateVersionRepository.promoteDraft(tx, {
        id: draftId,
        expectedToken: expectedDraftToken,
        blobRef,
        checksum: indexDigest,
        checksumAlgorithm: "sha256",
        activatedBy: actorId,
        changeNote,
      });
      if (!promoted) throw new ActivationRollback("DRAFT_CONFLICT");

      await insertAuditEvent(tx, {
        eventType: "INVOICE_TEMPLATE_ACTIVATED",
        actorUserId: actorId,
        targetEntity: "BILL_TEMPLATE_VERSION",
        targetId: promoted.billTemplateVersionId,
        beforeData: {
          activeVersionId: previous?.billTemplateVersionId ?? null,
          activeVersionNo: previous?.versionNo ?? null,
        },
        afterData: {
          activatedVersionId: promoted.billTemplateVersionId,
          versionNo: promoted.versionNo,
          retiredVersionId: retired?.billTemplateVersionId ?? null,
          changeNote,
          blobRef,
          checksum: indexDigest,
        },
      });

      return {
        ok: true,
        versionId: promoted.billTemplateVersionId,
        versionNo: promoted.versionNo,
        retiredVersionId: retired?.billTemplateVersionId ?? null,
        blobRef,
        checksum: indexDigest,
      };
    });
  } catch (error) {
    if (error instanceof ActivationRollback) {
      return { ok: false, code: error.code };
    }
    // Any other database error: rolled back, the step-7 blobs stay as orphans.
    throw error;
  }
}
