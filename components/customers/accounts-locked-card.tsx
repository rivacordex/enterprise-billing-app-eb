// cm20 (custmgmt-ui-context §9.3) — the Accounts tab for a viewer without
// `accounts_view : READ`. Static: the page decides the lock (Inv. #12) and no
// account query runs behind this card.

import { Lock } from "lucide-react";

export function AccountsLockedCard(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-[color:var(--surface-sunken)] p-4 text-body-sm text-[color:var(--text-muted)]">
      <Lock size={16} aria-hidden="true" />
      <span>Requires accounts access</span>
    </div>
  );
}
