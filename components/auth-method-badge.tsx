import { Key, ShieldCheck, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AuthMethod } from "@/types/rbac";

export interface AuthMethodBadgeProps {
  authMethod: AuthMethod;
  className?: string;
}

// Arbitrary-value utilities reference the cyan/neutral CSS custom
// properties directly (ui-context §3.5) — see status-badge.tsx for why.
const AUTH_METHOD_TOKENS = {
  SSO: {
    bg: "bg-[color:var(--color-cyan-50)]",
    text: "text-[color:var(--color-cyan-700)]",
    icon: ShieldCheck,
    label: "SSO",
  },
  LOCAL: {
    bg: "bg-[color:var(--color-neutral-100)]",
    text: "text-[color:var(--color-neutral-700)]",
    icon: Key,
    label: "Local",
  },
} as const satisfies Record<
  AuthMethod,
  { bg: string; text: string; icon: LucideIcon; label: string }
>;

export function AuthMethodBadge({
  authMethod,
  className,
}: AuthMethodBadgeProps): React.JSX.Element {
  const { bg, text, icon: Icon, label } = AUTH_METHOD_TOKENS[authMethod];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase",
        bg,
        text,
        className,
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
