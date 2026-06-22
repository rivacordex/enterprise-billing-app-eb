# Spec: um26 — Logout (sidebar sign-out button)

**Boundary:** FRONTEND  
**Depends on:** um06 (`components/sign-out-button.tsx` — `SignOutButton` client component already built for `/no-access`); um07 (`app/(admin)/layout.tsx` sidebar + `components/admin-nav.tsx` — the sidebar chrome built for the Users page).

---

## Goal

Add a user identity strip and sign-out button to the bottom of the existing admin sidebar, reusing the `SignOutButton` already built in um06, so that any authenticated user in the admin shell can sign out from any page.

---

## Design

### What exists (do not re-build)

- `components/sign-out-button.tsx` — `'use client'` `SignOutButton` component, built in um06 for the `/no-access` page. Calls the Better-Auth sign-out endpoint and redirects to `/login`. This component is reused as-is.
- `app/(admin)/layout.tsx` sidebar — built in um07. Currently: app name lockup at top, `<AdminNav />` for the four nav links, nothing else. The `<aside>` is `flex flex-col` but has no footer.

### What um26 adds

A **sidebar footer** pinned to the bottom of the `<aside>`, containing:

1. A top divider: `border-t border-white/10` (consistent with the existing lockup divider in um07).
2. **User identity strip** — displays the signed-in user's `user_name` and `user_email`. Read-only; no click target. `user_name` in `text-sm font-medium text-white truncate`; `user_email` in `text-xs text-[--color-primary-300] truncate`. Both truncated so long values don't overflow the sidebar width.
3. A second divider: `border-t border-white/10`.
4. **`<SignOutButton />`** — imported from `components/sign-out-button.tsx`. Restyled for the dark nav surface if the existing component uses light-mode tokens (see §Implementation for how to handle this).

The footer is pinned via `mt-auto` on the footer `<div>`. `<AdminNav />` already sits above it; adding `flex-1` to the `<AdminNav />` wrapper (or to the nav element itself) ensures the nav takes the remaining space and the footer stays at the bottom.

### `SignOutButton` appearance on the dark nav

The existing `SignOutButton` was designed for the `/no-access` page (light surface). For the sidebar, it needs dark-surface styling. Two options — choose one at implementation time:

**Option A — prop-based variant (preferred):** Add an optional `variant?: 'light' | 'nav'` prop to `SignOutButton`. The `'nav'` variant applies dark-surface token classes: `text-[--color-primary-300] hover:bg-[--color-primary-700] hover:text-white`. The default (no prop) retains the existing light-mode appearance for `/no-access`.

**Option B — separate component:** Create `components/nav-sign-out-button.tsx` as a thin wrapper around the same sign-out action, styled for the dark surface. Avoids touching `SignOutButton` but adds a second file.

Whichever option is chosen, the visual spec for the button in the sidebar is:

- Full-width, `px-4 py-3`, `flex items-center gap-2`
- `LogOut` lucide icon (size 16), `aria-hidden`
- Label: "Sign out"
- Default color: `text-[--color-primary-300]`
- Hover: `bg-[--color-primary-700]`, text `text-white`
- Pending (in-flight): spinner (`Loader2`, `animate-spin`) + "Signing out…"; button `disabled`
- Focus ring: `focus-visible:ring-2 focus-visible:ring-[--border-focus]`
- No red/destructive styling

### No audit event

`USER_LOGOUT` is not in the project's defined audit event set (overview §"Audit Events"). No new event is introduced.

---

## Implementation

### 26.1 — `app/(admin)/layout.tsx` update

The layout already resolves the current user to perform the permission guard (via `requirePermission` or equivalent). The resolved `user_name` and `user_email` from `APPUSER` are already in scope — no new DB query is needed.

The `<aside>` currently renders:

```tsx
<aside
  className="flex w-64 flex-shrink-0 flex-col"
  style={{ background: "var(--surface-nav)" }}
>
  <div className="border-b border-white/10 px-4 py-5">
    <span className="text-sm font-semibold text-white">Enterprise Billing</span>
  </div>
  <AdminNav />
</aside>
```

Update to add the footer:

```tsx
<aside
  className="flex w-64 flex-shrink-0 flex-col"
  style={{ background: "var(--surface-nav)" }}
>
  {/* App name lockup — unchanged */}
  <div className="border-b border-white/10 px-4 py-5">
    <span className="text-sm font-semibold text-white">Enterprise Billing</span>
  </div>

  {/* Nav links — add flex-1 so the footer is pushed to the bottom */}
  <div className="flex-1 overflow-y-auto">
    <AdminNav />
  </div>

  {/* Footer — identity strip + sign-out */}
  <div className="mt-auto">
    <div className="border-t border-white/10" />
    <div className="px-4 py-3">
      <p className="truncate text-sm font-medium text-white">{user.userName}</p>
      <p className="mt-0.5 truncate text-xs text-[--color-primary-300]">
        {user.userEmail}
      </p>
    </div>
    <div className="border-t border-white/10" />
    <div className="p-2">
      <SignOutButton variant="nav" /> {/* if Option A */}
    </div>
  </div>
</aside>
```

`user.userName` and `user.userEmail` come from the existing resolved `APPUSER` — already fetched by the layout's session/permission resolution. No additional `db/**` import.

### 26.2 — `SignOutButton` update (if Option A)

In `components/sign-out-button.tsx`, add an optional `variant` prop:

```ts
interface SignOutButtonProps {
  variant?: "light" | "nav";
}
```

Apply `nav` classes when `variant === 'nav'`:

- Container: `text-[--color-primary-300] hover:bg-[--color-primary-700] hover:text-white` instead of the default light-surface classes.
- All other behavior (pending state, disabled, aria attributes) is unchanged.

The `/no-access` page's existing `<SignOutButton />` call with no prop continues to render the light-mode appearance — no regression.

---

## Dependencies

No new npm packages. All required are already installed:

- `lucide-react` — `LogOut`, `Loader2` (already used by `SignOutButton`)
- `react` — `useTransition` (already in `SignOutButton`)

No new migrations, no new `PERMISSIONS` rows, no new Server Actions — the sign-out mechanism uses the existing Better-Auth `/api/auth/sign-out` endpoint already wired in um06.

---

## Verification Checklist

### Sidebar footer

- [ ] A user identity strip appears at the bottom of the sidebar on all four admin pages
- [ ] `user_name` is displayed in `text-sm font-medium text-white`
- [ ] `user_email` is displayed in `text-xs text-[--color-primary-300]`
- [ ] Both values are `truncate` — long names/emails do not overflow the sidebar
- [ ] The identity strip is separated from the nav links by a `border-t border-white/10` divider
- [ ] The "Sign out" button appears below the identity strip, separated by a second divider
- [ ] The footer is pinned to the bottom of the sidebar — it does not scroll away with the nav links
- [ ] The nav links area takes the available vertical space between the header lockup and the footer (`flex-1 overflow-y-auto`)

### Sign-out button (sidebar variant)

- [ ] Renders `LogOut` icon + "Sign out" label in default state
- [ ] Default text color is `--color-primary-300` (muted on dark nav)
- [ ] Hover applies `--color-primary-700` background and `text-white`
- [ ] Pending state: `Loader2` spinner + "Signing out…"; button is `disabled`
- [ ] No red/destructive styling
- [ ] Focus ring visible (`--border-focus`), keyboard-navigable
- [ ] `aria-label="Sign out"` present on the button element
- [ ] No hardcoded hex — CSS variable tokens only

### Behavior

- [ ] Clicking "Sign out" in the sidebar signs the user out and redirects to `/login`
- [ ] After sign-out, navigating back to any admin page redirects to `/login`
- [ ] Double-clicking is a no-op (button `disabled` while pending)
- [ ] The existing `SignOutButton` on `/no-access` still renders correctly in its light-mode appearance (no regression from the variant change)

### Layout / no new DB queries

- [ ] `user_name` and `user_email` in the footer come from the user already resolved by the layout — no additional `db/**` import or DB call in `layout.tsx`
- [ ] `app/(admin)/layout.tsx` does not import from `db/**` directly

### `SignOutButton` (if Option A)

- [ ] `variant` prop is optional; default (`undefined` or `'light'`) preserves existing appearance
- [ ] `variant="nav"` applies dark-surface token classes

### Tests

#### Unit — `SignOutButton` variant (`tests/unit/components/sign-out-button.test.tsx`)

| Scenario                           | Expected                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Default render (no `variant` prop) | Existing light-mode classes applied                                                        |
| `variant="nav"` render             | `text-[--color-primary-300]` class applied; `hover:bg-[--color-primary-700]` class applied |
| Both variants — pending state      | Spinner + "Signing out…"; button disabled                                                  |

#### Unit — admin layout sidebar footer (`tests/unit/app/admin-layout.test.tsx`)

| Scenario                          | Expected                                           |
| --------------------------------- | -------------------------------------------------- |
| Sidebar renders                   | User name and email appear in the footer           |
| Long `user_name`                  | Rendered without overflow (truncate class present) |
| `<SignOutButton variant="nav" />` | Present in the sidebar footer                      |
| Nav links area                    | Still renders all four links (no regression)       |

### Scope guard

- [ ] No new Server Actions — sign-out uses the existing Better-Auth endpoint wired in um06
- [ ] No new `PERMISSIONS` rows or schema migrations
- [ ] No audit event written — `USER_LOGOUT` is not in the defined event set
- [ ] No changes to the `/no-access` page behaviour — it continues to use `<SignOutButton />` (no prop)
- [ ] No changes to the `/set-password` sign-out link
