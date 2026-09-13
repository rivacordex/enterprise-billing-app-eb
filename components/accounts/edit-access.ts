// D7: the tooltip shown on a disabled Accounts-Settings mutation control when
// the viewer holds `accounts_config:READ` but not `EDIT`. Single source so the
// three form files (reason-code, bill-cycle, wizard-defaults) can't drift — the
// backing Server Actions re-check `:EDIT`, so the greying is UX only (Inv #3).
export const EDIT_DISABLED_TITLE =
  "Requires accounts configuration edit access";
