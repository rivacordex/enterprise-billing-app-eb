import Link from "next/link";

import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
import {
  LIFECYCLE_BADGE_VARIANTS,
  LifecycleBadge,
} from "@/components/products/lifecycle-badge";
import { cn } from "@/lib/utils";
import type { LifecycleStatus, VersionSummary } from "@/types/product";

// pm40 I4/D2. A row of `<Link>`s (not a dropdown, not a `tablist`) — one compact
// entry per version, `v{n}` + LifecycleBadge, ordered newest-first (the caller
// hands them in version DESC). The selected entry carries `--surface-selected`
// and `aria-current="page"`; the rest `--surface-sunken`. A family with one
// version renders that single entry with no affordance implying more (ui-context
// §6). At scale the bar scrolls horizontally with an edge-fade and never wraps to
// stacked rows (which would push the panels down unboundedly); descending order
// keeps the ACTIVE/open version at the left edge, visible without scrolling.
// Entries stay tab-navigable (plain links) — a focused off-screen link scrolls
// into view natively, no custom key handler (ui-context §7).
export interface VersionBarProps {
  versions: VersionSummary[];
  selectedVersionId: string;
  query: string;
  status: LifecycleStatus | null;
  page: number;
  family: string;
}

export function VersionBar({
  versions,
  selectedVersionId,
  query,
  status,
  page,
  family,
}: VersionBarProps): React.JSX.Element {
  return (
    // The edge-fade rides a mask on the scroll container: it only visibly fades
    // when content overflows the width, and stays out of the tab order.
    // `overflow-x-auto` forces `overflow-y: auto` (CSS spec), which would clip
    // the 4px `--focus-ring` on the links top/bottom — so the container carries
    // `p-1.5` (6px) to keep the ring inside its padding box. `scroll-pr-8` (2rem,
    // the fade width) makes a keyboard-focused off-screen link scroll to sit
    // clear of the right-edge fade rather than under it (ui-context §7).
    <nav
      aria-label="Versions"
      className="scroll-pr-8 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] p-1.5"
    >
      <ul className="flex flex-nowrap items-center gap-2">
        {versions.map((version) => {
          const isSelected = version.productOfferingId === selectedVersionId;
          const variant = LIFECYCLE_BADGE_VARIANTS[version.lifecycleStatus];

          return (
            <li key={version.productOfferingId} className="shrink-0">
              <Link
                href={buildManageProductsHref({
                  q: query,
                  status,
                  page,
                  family,
                  version: version.productOfferingId,
                })}
                aria-current={isSelected ? "page" : undefined}
                aria-label={`Version ${version.version}, ${variant.label.toLowerCase()}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none [@media(pointer:coarse)]:min-h-[44px]",
                  isSelected
                    ? "border-[color:var(--border-default)] bg-[color:var(--surface-selected)]"
                    : "border-transparent bg-[color:var(--surface-sunken)] hover:bg-[color:var(--action-ghost-hover)]",
                )}
              >
                <span className="font-mono text-body-sm font-semibold text-foreground tabular-nums">
                  v{version.version}
                </span>
                <LifecycleBadge status={version.lifecycleStatus} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
