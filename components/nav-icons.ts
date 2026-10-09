import {
  ArrowLeftRight,
  BookOpen,
  Building2,
  ClipboardList,
  Compass,
  FileText,
  Landmark,
  Layers,
  Package,
  PackagePlus,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldHalf,
  SlidersHorizontal,
  TableProperties,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { NavHref } from "@/lib/nav-registry";

// The presentation half of the nav registry (plan §3.2): the lucide glyph for
// each registry href. Kept out of `lib/nav-registry.ts` because `lib/**` may
// import only `lib` and `types` (the deny-by-default `boundaries` rule), and
// lucide-react is neither. Keying the record by `NavHref` makes a missing or
// stale icon a *compile* error, so the two-file split cannot drift — the §6.3
// gate re-checks set-equality as belt-and-suspenders.
//
// Roles → `ShieldHalf` (not `ShieldCheck`): the filled shield-check glyph is
// already the SSO `AuthMethodBadge` (ui-context §3.5), so reusing it for Roles
// would make one glyph mean two things. `ShieldHalf` stays in the shield/
// authority family (right for RBAC) while staying distinct. `Settings` for
// System Configuration matches `ConfigTable`'s empty-state icon (um28-spec §2.5).
// `Package` for Product Offering: catalog/goods family, no glyph collision
// with existing nav or badge icons. `Building2` for View Customer: the
// organization/legal-entity glyph (the page is about `organization` +
// `party_role`, not a person). `UserCog` for Manage Customer: the
// administer-a-person-like-record glyph, distinct from `Settings`'s
// gear-only meaning and from `Users` (already User Management's).
// `PackagePlus` for Manage Products: same catalog/goods family as `Package`
// (View Product), signaling the create/mutate capability the same way
// `Building2`/`UserCog` stay in one semantic domain while remaining visually
// distinct; no glyph collision with any existing nav or badge icon.
// `TableProperties` for Rate Card (pm65, ui-context §10 — the mockup's tabler
// `table-options`): a table-with-settings glyph, no collision with
// `Package`/`PackagePlus`/`ClipboardList`/`Layers`.
// `FileText` for Invoice Settings is the glyph bm55-spec D6 names. It is also
// GL Journal's; the two sit in different sections (Accounts / Administration).
export const NAV_ICONS: Record<NavHref, LucideIcon> = {
  "/products/product-offering": Package,
  "/products/manage-products": PackagePlus,
  "/products/orders": ClipboardList,
  "/products/subscriptions": Layers,
  "/products/rate-card": TableProperties,
  "/customers/view": Building2,
  "/customers/manage": UserCog,
  "/accounts/overview": Landmark,
  "/accounts/transactions": ArrowLeftRight,
  "/accounts/ledger": Compass,
  "/accounts/chart-of-accounts": BookOpen,
  "/accounts/gl-journal": FileText,
  "/billing/bill-runs": ReceiptText,
  "/administration/users": Users,
  "/administration/roles": ShieldHalf,
  "/administration/system-config": Settings,
  "/administration/invoice-settings": FileText,
  "/administration/audit-log": ScrollText,
  "/administration/accounts-settings": SlidersHorizontal,
};
