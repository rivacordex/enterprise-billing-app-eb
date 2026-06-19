import { cn } from "@/lib/utils";

export interface RoleBadgeProps {
  roleName: string;
  className?: string;
}

// Arbitrary-value utilities reference the primary/cyan/neutral CSS custom
// properties directly (ui-context §3.6) — see status-badge.tsx for why.
const ROLE_TOKENS: Record<string, { bg: string; text: string }> = {
  ADMIN: {
    bg: "bg-[color:var(--color-primary-50)]",
    text: "text-[color:var(--color-primary-700)]",
  },
  MANAGER: {
    bg: "bg-[color:var(--color-cyan-50)]",
    text: "text-[color:var(--color-cyan-700)]",
  },
  USER: {
    bg: "bg-[color:var(--color-neutral-100)]",
    text: "text-[color:var(--color-neutral-700)]",
  },
};

// Future-proof fallback for any role name not in the table above.
const FALLBACK_TOKENS = {
  bg: "bg-[color:var(--color-neutral-100)]",
  text: "text-[color:var(--color-neutral-700)]",
};

export function RoleBadge({
  roleName,
  className,
}: RoleBadgeProps): React.JSX.Element {
  const { bg, text } = ROLE_TOKENS[roleName] ?? FALLBACK_TOKENS;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tracking-wider uppercase",
        bg,
        text,
        className,
      )}
    >
      {roleName}
    </span>
  );
}
