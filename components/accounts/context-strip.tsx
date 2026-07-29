// Persistent party/FA/BAN selection header (acctmgmt-ui-context.md §1.1,
// code-standards §3.1, ac05-spec §2.2). URL-driven — a pasted URL reproduces
// the working context. Absent fields render greyed "no selection" affordances.
// IDs are mono (ui-context §3). No router mutation here — the page links drive
// context changes.

import { Building2, FileText, Landmark } from "lucide-react";

import { cn } from "@/lib/utils";

// Explicit `string | undefined` (not `?:`) throughout — exactOptionalPropertyTypes
// is enabled; callers always supply all keys, absent values are `undefined`.
export interface ContextStripProps {
  party: string | undefined;
  partyName: string | undefined;
  fa: string | undefined;
  faName: string | undefined;
  ban: string | undefined;
  banName: string | undefined;
  className?: string;
}

function ContextField({
  icon: Icon,
  label,
  id,
  name,
}: {
  icon: typeof Landmark;
  label: string;
  id: string | undefined;
  name: string | undefined;
}): React.JSX.Element {
  const hasValue = Boolean(id);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[11px] font-semibold tracking-wider text-[color:var(--text-muted)] uppercase">
        <Icon size={11} aria-hidden />
        {label}
      </span>
      {hasValue ? (
        <span className="flex flex-col gap-0">
          {name && (
            <span className="truncate text-body font-medium text-[color:var(--text-primary)]">
              {name}
            </span>
          )}
          <span className="font-mono text-body-sm text-[color:var(--text-body)]">
            {id}
          </span>
        </span>
      ) : (
        <span className="text-body-sm text-[color:var(--text-disabled)] italic">
          No selection
        </span>
      )}
    </div>
  );
}

export function ContextStrip({
  party,
  partyName,
  fa,
  faName,
  ban,
  banName,
  className,
}: ContextStripProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-8 gap-y-3 rounded-sm border px-4 py-3",
        "border-[color:var(--acct-context-strip-border)] bg-[color:var(--acct-context-strip-bg)]",
        className,
      )}
    >
      <ContextField
        icon={Building2}
        label="Customer"
        id={party}
        name={partyName}
      />
      <ContextField
        icon={Landmark}
        label="Financial Account"
        id={fa}
        name={faName}
      />
      <ContextField
        icon={FileText}
        label="Billing Account"
        id={ban}
        name={banName}
      />
    </div>
  );
}
