// Single source of truth for "can this posted document be reversed?" (bm11).
// Every reversal entry point (reverse-document, reverse-line, and the
// get-reversal-preview read) must consult this so the rule lives in one place —
// a new reversal/adjustment path that forgets it would reverse an INV's ledger
// effect while `customer_bill.ref_inv_document_id` stays set, desyncing the
// bill from the ledger (a state bm09-11 has no reconciliation path for).

// An `INV` is finalized by the bill-run posting flow, which owns the
// `customer_bill.ref_inv_document_id` finalization latch. Reversing one here
// would undo its ledger effect without clearing that latch, so INV reversal is
// out of scope; corrections go through a credit note. The returned code is a
// member of every reversal service's Result union.
export function checkDocumentReversible(doc: {
  docType: string;
}): { ok: false; code: "INV_NOT_REVERSIBLE" } | null {
  if (doc.docType === "INV") {
    return { ok: false, code: "INV_NOT_REVERSIBLE" };
  }
  return null;
}
