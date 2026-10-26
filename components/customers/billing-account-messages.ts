// cm23 (custmgmt code-standards §10 Styling rule 3) — the Billing account panel
// and onboarding-field copy, defined once. Changing any string here is a copy
// change (custmgmt workflow rules §10.5).

import type { SetBillingAccountTemplateActionResult } from "@/actions/accounts/set-billing-account-template";
import { STANDARD_TYPE_NAME } from "@/types/accounts";

export const GENERIC_FAILURE = "Something went wrong. Please try again.";

type FailureCode = Extract<
  SetBillingAccountTemplateActionResult,
  { ok: false }
>["code"];

export const BIND_FAILURE_MESSAGES: Record<FailureCode, string> = {
  CONFLICT:
    "This billing account was changed by someone else. Reload and try again.",
  BAN_CLOSED: "This billing account is closed.",
  TEMPLATE_NOT_BINDABLE:
    "This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded.",
  BAN_NOT_FOUND: "Billing account not found. Reload the page.",
  FORBIDDEN: "You do not have permission to change billing accounts.",
  // Not spec-defined (bad ids from a tampered request); the module's generic
  // failure copy, same as the contact panel.
  VALIDATION_ERROR: GENERIC_FAILURE,
};

export const NEXT_RUN_CAPTION =
  "Changes apply from the next bill run start or rerun.";

export const TEMPLATE_TYPE_FIELD_LABEL = "Invoice template type";

export const ONBOARDING_TEMPLATE_LABEL = TEMPLATE_TYPE_FIELD_LABEL;
export const ONBOARDING_TEMPLATE_VALUE = STANDARD_TYPE_NAME;
export const ONBOARDING_TEMPLATE_HELP =
  "New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account.";
