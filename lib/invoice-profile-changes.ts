import {
  INVOICE_PROFILE_FIELD_LABELS,
  INVOICE_PROFILE_PAYMENT_KEYS,
} from "@/types/billing";

// bm61-spec §Design D4–D6 — pure helpers shared by the activation service and
// the activate dialog, so the warning the admin sees and the audit row's
// `bankDetailsChanged` flag use one definition of "bank details changed".

type FieldMap = Readonly<Record<string, string | null | undefined>>;

function value(map: FieldMap | null, key: string): string | null {
  const v = map?.[key];
  return v === undefined || v === null || v.trim() === "" ? null : v;
}

// Whether any payment field differs from the ACTIVE version. With no ACTIVE
// version every payment field is new, so the first activation counts as a bank
// change: it sets the account customers pay into.
export function paymentFieldsChanged(
  active: FieldMap | null,
  draft: FieldMap,
): boolean {
  return INVOICE_PROFILE_PAYMENT_KEYS.some(
    (key) => value(active, key) !== value(draft, key),
  );
}

export interface ProfileFieldChange {
  key: string;
  label: string;
  from: string | null;
  to: string | null;
}

// D5 — the fields that differ from the ACTIVE version, as `label: old → new`
// (account numbers in full), in label order.
export function describeProfileChanges(
  active: FieldMap | null,
  draft: FieldMap,
): ProfileFieldChange[] {
  const changes: ProfileFieldChange[] = [];
  for (const [key, label] of Object.entries(INVOICE_PROFILE_FIELD_LABELS)) {
    const from = value(active, key);
    const to = value(draft, key);
    if (from !== to) changes.push({ key, label, from, to });
  }
  return changes;
}
