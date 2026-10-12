// cm20 (custmgmt-ui-context §9.3) — no Financial Account exists for the party
// role yet (customer still INITIALIZED). Info family, static.

import { Info } from "lucide-react";

export function AccountsNotOnboardedCard(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md bg-[color:var(--color-info-50)] p-4 text-body-sm text-[color:var(--color-info-700)]">
      <Info size={16} aria-hidden="true" />
      <span>Accounts are created when the customer is validated.</span>
    </div>
  );
}
