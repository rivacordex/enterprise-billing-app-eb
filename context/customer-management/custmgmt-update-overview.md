# Customer Management — Update Overview (Invoice Template Types: bind a BAN to a template type)

This file holds the in-flight update to the Customer Management module. It is folded into `custmgmt-project-overview.md` at the update's ship gate, and then deleted until the next update is planned. The previous update (Invoice Template Binding, cm17–cm22) is delivered, signed off on 2026-10-25, and folded there.

| Update | Status |
|---|---|
| Invoice Template Types: Customer Management part (bind a BAN to a template type) | In progress: cm23 built (lands in one merge with Billing bm82); cm24 not started |

_Date: 2026-10-25 · **Users:** RevOps staff holding `customers : EDIT` + `accounts_transactions : EDIT` bind BANs, and everyone holding `customers : READ` (+ `accounts_view : READ`) sees the binding. **Owning update:** Billing, `context/billing-management/billmgmt-update-overview.md`, which defines template types, upload, activation, retire and export. **This file defines only what changes in Customer Management.**_

---

## Overview

The Customer Management module is where Revenue Operations maintains enterprise customers: their organization, customer role, contacts and, since the Invoice Template Binding update, a read of their accounting data. That covers the Financial Account, billing accounts (BANs), balances and documents, plus a per-BAN invoice template reference. Today that reference accepts only `NULL` ("follow the active template"). The Manage Customer panel offers only a "Reset to follow active template" button that is never enabled, and posting ignores the reference.

Billing's update now introduces a catalog of **invoice template types**: Standard plus any number of new types, each with its own layout. This update lets RevOps **bind each BAN to a usable type** from Manage Customer. `NULL` still means Standard. The bill run captures the BAN's type at the next run start or rerun. View Customer and Manage Customer show the type each BAN will invoice on.

## Goals

1. **Replace the BAN's version reference with a type reference:** `billing.billing_account.ref_bill_template_family_id` (FK to `billing.bill_template_family`), with `NULL` = Standard. The old `ref_bill_template_version_id` is dropped. The migration aborts if any BAN holds a non-`NULL` version value.
2. **Let RevOps bind a BAN to any usable type** (not retired, has an ACTIVE version), or back to Standard, from the Manage Customer Billing account panel. The write is audited and concurrency-safe.
3. **Keep Standard stored only as `NULL`.** Choosing "Standard (default)" writes `NULL`, and an explicit Standard id is rejected.
4. **Serialise binding against Billing's retire:** the bind gate locks the type row `FOR SHARE` and re-checks that it's usable inside the same transaction.
5. **Show the truth:** every BAN label names the type and the version the next bill run will capture, read live.
6. **Leave onboarding unchanged in behaviour:** a new BAN starts on Standard (`NULL`); only the field's wording changes.

## Core user flow

1. **Bind a BAN (RevOps, `customers : EDIT` + `accounts_transactions : EDIT`).**
   1. Open **Manage Customer** for an onboarded customer. The **Billing account** panel lists each BAN with its state chip and current type label.
   2. Each open BAN row shows an **Invoice template type** select: **"Standard (default)"** first, then every usable type in name order. The select starts on the BAN's current type, and **Save** is enabled only when the selection differs from it.
   3. A user with `customers : EDIT` only sees the select and Save disabled, with the `EDIT_DISABLED_TITLE` tooltip. A closed BAN shows "Billing account is closed" and no select.
   4. **Save** runs one transaction:
      1. the BAN's compare-and-set on `last_modified` (`CONFLICT` if stale)
      2. `assertBindableTemplate`, which locks the chosen type `FOR SHARE` and requires it to be usable (`TEMPLATE_NOT_BINDABLE` if not); `NULL` needs no lock
      3. the column update and `last_edited_by`
      4. `BILLING_ACCOUNT_TEMPLATE_CHANGED`, with before and after type id and name

      If the value is unchanged, nothing is written and no audit row is recorded.
   5. If the chosen type was retired while the panel was open, the save fails with **"This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."** The panel reloads the BAN's current type and the usable-type list. There is no automatic retry.
   6. The caption under the panel reads **"Changes apply from the next bill run start or rerun."** Runs already in progress keep the type they captured.
2. **See the binding (anyone with `customers : READ`).**
   - **View Customer → Accounts tab** (`accounts_view : READ`): each BAN card shows **Invoice template type** with the label.
   - **Manage Customer → Billing account panel:** the same label on each row.
3. **Onboard (unchanged behaviour).** The onboarding wizard's read-only field now reads **"Invoice template type: Standard (default)"**, with the help text **"New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account."** The BAN is created with `NULL`.
4. **Retire (Billing-owned, affects these screens).** When a manager retires a type in Invoice Settings, Billing's bulk switch moves every bound BAN to the chosen target, and writes one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per BAN with `reason: 'TEMPLATE_TYPE_RETIRED'`. The customer screens show the new type on the next load. Customer Management code takes no part in the switch.

## Features

### Data model

- **One migration on the Accounts-owned `billing.billing_account`:** add `ref_bill_template_family_id text` (FK to `billing.bill_template_family`, nullable; `NULL` = Standard), abort if any `ref_bill_template_version_id` is non-`NULL`, then drop `ref_bill_template_version_id` and its FK.
- No backfill, because every BAN is `NULL` today. No index (about 5 BANs in total).
- The column comment reads "Invoice template type; NULL = Standard (the default type)".
- No change to `customer` schema tables.

### Bind gate

- **`assertBindableTemplate(tx, typeId | null)`** is the one validator, shared by onboarding and the bind service.
  - `null` → accepted.
  - A type id → `lockTemplateType(tx, typeId, 'share')`, then accepted only if the type exists, isn't retired and has an ACTIVE settings version.
  - An explicit Standard id, an unknown id, a retired type or a not-yet-usable type → `TEMPLATE_NOT_BINDABLE`.
- **`setBillingAccountTemplate`** keeps its delivered shape (BAN compare-and-set, one transaction, no write on an unchanged value) and now takes `typeId | null`. Result codes: `BAN_NOT_FOUND`, `BAN_CLOSED`, `CONFLICT`, `TEMPLATE_NOT_BINDABLE`.
- **The action** keeps its dual guard (`customers : EDIT`, then `accounts_transactions : EDIT` from the `permissionMap`), then Zod, the service and `revalidatePath` on the manage and view routes.

### Usable-type list and labels

- **`listBindableTemplateTypes()`** is a read in `services/accounts/`. It calls Billing's type **repository** (never a Billing service) and returns `[{ typeId: null, name: "Standard (default)" }, …usable non-default types sorted by name]`.
- **`resolveBanTemplateLabel(ban)`** reads live, never cached:
  - `NULL` → **"Standard (default) · v{N}"**, where N is Standard's ACTIVE version
  - a usable type → **"{type name} · v{N}"**
  - a type with no ACTIVE version or a retired type (possible only after an SQL bypass) → **"{type name} · not usable"**, styled as a warning, because the next run will block that BAN's approval until it is rebound or the type is activated
- The old strings **"Follows active template (currently: … vN), as of now"** and **"Template reference not supported yet"** are removed.

### Manage Customer panel

- The **Reset to follow active template** button is **replaced** by the per-BAN select and Save described in Core user flow step 1.
- Permission greying, closed-BAN handling, the in-panel `AccountsUnavailableCard` and one-save-at-a-time behaviour are unchanged.

### View Customer Accounts tab

- Each BAN card's template line becomes **"Invoice template type"** with the new label.
- The tab stays read-only, with no binding control.

### Onboarding

- The wizard field's label and help text change (Core user flow step 3). It still submits `null`, reads no type list, and keeps its dual guard and atomic transaction.

### Access and audit

| Action | Permission |
|---|---|
| View the label (Manage Customer, View Customer Accounts tab) | `customers : READ` / `customers : EDIT` page guards, + `accounts_view : READ` for the Accounts tab |
| Bind or rebind a BAN | `customers : EDIT` + `accounts_transactions : EDIT`, re-checked in the action |

- No new permission and no new audit event type. `BILLING_ACCOUNT_TEMPLATE_CHANGED` now carries the type id and name before and after, plus an optional `reason`.

## In scope

- The `billing_account` migration (version reference → type reference), its Drizzle mirror and FK.
- `assertBindableTemplate` accepting usable types under `FOR SHARE`, and rejecting an explicit Standard id.
- `setBillingAccountTemplate` and its action taking `typeId | null`, with unchanged guards, locking and audit.
- `listBindableTemplateTypes` and the new `resolveBanTemplateLabel`.
- The Manage Customer panel select and Save, the retired-type message and the "next bill run" caption.
- The View Customer Accounts tab label.
- Onboarding wording.
- Tests: the bind gate, the panel, labels, the migration abort, and the race with Billing's retire (shared with Billing).
- Docs: the Customer Management architecture, code standards, UI context and workflow rules, plus the `cm05` and `ac04` specs where they quote the old wording.

## Out of scope

- **Creating, uploading, activating, retiring or exporting template types.** All of these are Billing's (Invoice Settings).
- **Choosing a type during onboarding.** A new BAN always starts on Standard.
- **Binding from Accounts-module screens,** or bulk-binding several BANs at once. Bulk moves happen only through Billing's retire.
- **Pinning a BAN to a specific version.** A BAN follows its type's ACTIVE version.
- **A new permission or a new audit event type.**
- **Any change to the `customer` schema,** the transition maps or the customer lock (`party_role.last_modified_datetime`).
- **Showing a BAN's invoice preview** on customer screens.

## Success criteria

1. After the migration, `billing.billing_account.ref_bill_template_family_id` exists (nullable, FK to `bill_template_family`), `ref_bill_template_version_id` is gone, and every BAN reads `NULL`. On a database holding a non-`NULL` version binding, the migration aborts and drops nothing.
2. A user with both permissions binds an open BAN to a usable type: one row update, one `BILLING_ACCOUNT_TEMPLATE_CHANGED` with type names before and after, the BAN's `last_modified` bumped, and `party_role.last_modified_datetime` untouched.
3. Choosing "Standard (default)" writes `NULL`. Sending Standard's id, an unknown id, a retired type or a not-yet-usable type returns `TEMPLATE_NOT_BINDABLE` and writes nothing.
4. A stale save returns `CONFLICT`; a closed BAN returns `BAN_CLOSED`; another customer's BAN returns `BAN_NOT_FOUND`; an unchanged value writes nothing.
5. The action rejects a user missing `customers : EDIT` or `accounts_transactions : EDIT`, even with the UI bypassed. The panel greys the select and Save for a `customers : EDIT`-only user.
6. A bind racing Billing's retire of the same type either commits first (and is then switched by the retire) or fails `TEMPLATE_NOT_BINDABLE`. It never leaves a BAN on a retired type.
7. The panel and the Accounts tab show "Standard (default) · vN" for a `NULL` BAN and "{type} · vN" for a bound BAN, from a live read. Neither old label string exists in the code.
8. After a type is retired in Invoice Settings, the panel and the Accounts tab show each moved BAN on its new type, and the retired-mid-edit save shows the agreed message and reloads.
9. Onboarding creates the BAN with `NULL`, shows the new wording, and the V7 rollback test still passes.
10. The next bill run after a bind captures the BAN's type and its ACTIVE version (verified in Billing's end-to-end journey).
11. Typecheck, lint and vitest pass on a disposable Postgres. The Customer Management docs and the `cm05`/`ac04` specs move with the code.
