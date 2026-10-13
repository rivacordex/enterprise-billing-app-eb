// cm20 review — the Accounts tab when its read failed (e.g. a missing ledger
// binding or bill-cycle row). Keeps the failure inside the tab so the header,
// tab strip and the other tabs stay usable instead of the whole View Customer
// page falling through to customers/view/error.tsx. Danger family, static.

import { AlertTriangle } from "lucide-react";

export function AccountsUnavailableCard(): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md bg-[color:var(--color-danger-50)] p-4 text-body-sm text-[color:var(--color-danger-700)]"
    >
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        Account details could not be loaded. Try again, or open the customer in
        the Accounts module.
      </span>
    </div>
  );
}
