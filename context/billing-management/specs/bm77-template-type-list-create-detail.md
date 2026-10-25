# bm77 — Invoice template type list, create type and type detail page

**Unit:** bm77 (Invoice Template Types · Part 6, unit 4 of 12). **Boundary:** SETTINGS-UI: `app/(app)/administration/invoice-settings/invoice-template/**`, `actions/billing/invoice-settings/**`, `components/billing/invoice-settings/**`, the services and repositories they call, the `app_runtime` grant, and their tests. **Specs from:** `billmgmt-update-overview.md` › Core user flow step 1 and Features › Type catalog; `billmgmt-architecture.md` Inv #65, contradiction T7 and Storage (`bill_template_family`); `billmgmt-code-standards.md` › Invoice Template Types, General rules 8–10, TS rules 2 and 4, Next.js rules 3–5, Styling rules 1–2 and 6, Data rule 6, the permission map, and guardrail item 79 (grant half); `billmgmt-ui-context.md` §10a and §10e; `bm00-build-plan.md` Part 6, unit 77. **Model files:** `app/(app)/administration/invoice-settings/invoice-template/page.tsx` (the page being split) and `services/billing/read/invoice-template-settings.ts`.

> **Framing.** Today `/administration/invoice-settings/invoice-template` edits **one** family, and the default one is hard-wired three times:
> - `getInvoiceTemplatePageData` (`invoice-template-settings.ts:114`)
> - `saveTemplateDraft` (`save-template-draft.ts:79`)
> - `activateTemplate` (`activate-template.ts:204`)
>
> All three call `billTemplateFamilyRepository.findDefault`. The page heading says "there is no family switcher". Settings version numbers are global per kind (`nextVersionNo({ kind })`), and `app_runtime` has **SELECT only** on `bill_template_family` (`bootstrap-db-roles.sql:217-227`).
>
> bm77 turns the page into a **type list**, adds **Create type**, and moves today's editor to a **per-type detail page** `[typeId]`. Every place that hard-wired the default now takes the type from the URL. Standard keeps working exactly as before on its own detail page. A new type is created **empty** ("Not yet usable"): it has no layout and no settings until bm78 uploads one, so its detail page shows the empty state, and the Upload button arrives in bm78. The "Bound BANs" column waits for bm82, which ships in one merge with cm23, the unit that creates the BAN type column.

## Goal

A MANAGER/ADMIN sees every invoice template type on one list, with its status. They can create a new empty type by name: its code and layout code are derived, and it is audited. Each type has a detail page at `/administration/invoice-settings/invoice-template/[typeId]`, where Standard's settings save, preview and activate exactly as they do today.

## Design

**Structural decisions**

- **The list and the detail page are separate routes.**
  - **The list** (`invoice-template/page.tsx`) is a server component guarded at `invoice_settings : READ`. It renders `TemplateTypeList`, plus `CreateTemplateTypeDialog` for EDIT holders.
  - **The detail page** is `invoice-template/[typeId]/page.tsx`, with `loading.tsx` and `error.tsx` copied from today's page. It is guarded at READ and keeps today's tabs (`?tab=edit|generated|history`, `?version=`).
  - **Old bookmarks:** the list page receives no `tab` or `version`. If either is present, it `redirect`s to Standard's detail page with the same query, so old links keep working.
- **The type comes from the URL, never from `findDefault`.** `getInvoiceTemplatePageData(typeId, versionId, { canEdit })` loads the type with `billTemplateFamilyRepository.findById`, and an unknown id is a `notFound()`. `saveTemplateDraftInputSchema` and `activateTemplateInputSchema` gain `familyId: templateFamilyIdSchema`, joining the preview schema, which already has it. In code the name stays `family`; the URL segment is `[typeId]`, per the code standards.
  - `saveTemplateDraft` uses `input.familyId`.
  - `activateTemplate` checks that the draft's `refBillTemplateFamilyId === input.familyId` (else `DRAFT_CONFLICT`).
- **Version numbers are per type.** `nextVersionNo(tx, { kind, familyId })` returns `max(version_no) + 1` **within that type** (matching bm74's `btv_version_uq` per (type, kind)). For Standard the number is unchanged, because it is the only type with rows. `lockKind` (a global per-kind advisory lock) stays: it is coarser than needed, and safe.
  - **Note for bm79:** the generated blob path `generated/INVOICE/v<no>-<digest12>` relies on global numbering. bm79, the first unit that activates a non-Standard type, adds the type segment. bm77 activates only Standard.
- **Create type is one service with one transaction.** `services/billing/invoice-template/template-types.ts › createTemplateType({ name }, actorId)`:
  1. **Normalize the name:** trim, and collapse internal whitespace runs to one space.
  2. **Validate it** with `templateTypeNameSchema` (3–60 characters from `[A-Za-z0-9 &()-]`).
  3. **Reject a taken name:** if `lower(name)` matches any existing type, retired included, return `TEMPLATE_TYPE_NAME_TAKEN`.
  4. **Derive the code** with `deriveTemplateTypeCode`, appending the `_2`, `_3`… suffix on collision.
  5. **Derive the layout code:** `layoutCode = "INVTPL-" + code`.
  6. **Insert the row and audit `INVOICE_TEMPLATE_TYPE_CREATED`.** On a lost race, `btf_name_ci_uq` maps to `TEMPLATE_TYPE_NAME_TAKEN`, and `btf_code_uq` / `btf_layout_code_uq` retry with the next suffix (at most 5 attempts).
  7. **No version rows** are written: a type starts empty.
- **The code derivation is deterministic and DB-shaped.** Upper-case the name, replace each run of non-`[A-Z0-9]` characters with `_`, trim `_`, and prefix `T_` if the result doesn't start with a letter, then cut to 60 characters (`btf_code_format`). For example, "Wholesale" → `WHOLESALE`, "Wholesale & Retail (East)" → `WHOLESALE_RETAIL_EAST`, "5G Enterprise" → `T_5G_ENTERPRISE`. Users never see the code except in exports and logs.
- **Status is derived in one function.** `deriveTemplateTypeStatus({ retiredDatetime }, hasActiveSettings)` returns `RETIRED` if retired, else `USABLE` if the type has an ACTIVE (or default) settings version, else `NOT_YET_USABLE`. It is never stored and never recomputed inline.
- **The grant arrives just in time.** `bootstrap-db-roles.sql` grants `app_runtime` `INSERT, UPDATE` on `bill_template_family` and `USAGE` on `bill_template_family_seq`; `DELETE` stays revoked. The guard trigger (bm74), not the grant, decides which columns may change.
- **One badge.** `TemplateVersionStatusBadge` gains the three type states, using the ui-context §10a mapping (`USABLE` → the ACTIVE style, `NOT_YET_USABLE` → the DRAFT outline, `RETIRED` → the RETIRED style), plus the existing `isDefault` chip on Standard. No second badge component.
- **No "Bound BANs" column yet.** The column it would read (`billing_account.ref_bill_template_family_id`) arrives with cm23. The list's other columns ship now, and bm82 (cm23's merge partner) adds that column.
- **No Upload button yet.** The detail page's empty state renders its text only; bm78 adds the button inside it.

## Implementation

### 1. Grant: `db/bootstrap/bootstrap-db-roles.sql`

Replace the bm64 block (lines 217–227) with:

```sql
-- bm77 (Inv #65) — app_runtime creates template types (create type) and retires them
-- (bm83). INSERT + UPDATE + sequence USAGE; DELETE stays revoked (rows are never deleted).
-- bill_template_family_guard (0053) decides which columns may change: only
-- retired_datetime, never name / code / layout_code. billrun_runtime gets nothing.
GRANT SELECT, INSERT, UPDATE ON TABLE
  "billing"."bill_template_family"
TO app_runtime;
--> statement-breakpoint
REVOKE DELETE ON TABLE "billing"."bill_template_family" FROM app_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "billing"."bill_template_family_seq" TO app_runtime;
--> statement-breakpoint
```

### 2. Validation

- **`validation/billing/template-type.schema.ts` (new):**
  ```ts
  // bm77 — the type name as entered (normalized by the service before this runs).
  export const templateTypeNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9 &()-]{3,60}$/, "Use 3–60 letters, digits, spaces, & ( ) or -.");
  export const createTemplateTypeInputSchema = z.object({ name: z.string().max(200) }).strict();
  ```
  The raw input is capped at 200 characters before normalization.
- **`validation/billing/invoice-template-structure.schema.ts`:** `saveTemplateDraftInputSchema` gains `familyId: templateFamilyIdSchema`.
- **`validation/billing/activate-version.schema.ts`:** `activateTemplateInputSchema` gains `familyId: templateFamilyIdSchema`.
- **`validation/billing/invoice-settings-search-params.schema.ts`:** add `templateTypeIdParamSchema = templateFamilyIdSchema` for the `[typeId]` segment. A malformed id is `notFound()`.

### 3. Types: `types/billing.ts` (add)

```ts
export const TEMPLATE_TYPE_STATUSES = ["USABLE", "NOT_YET_USABLE", "RETIRED"] as const;
export type TemplateTypeStatus = (typeof TEMPLATE_TYPE_STATUSES)[number];

// code-standards › Invoice Template Types, TS rule 2 (later units add their codes).
export type TemplateTypeErrorCode =
  | "TEMPLATE_TYPE_NAME_TAKEN"
  | "TEMPLATE_TYPE_NAME_INVALID";

export interface TemplateTypeListRow {
  billTemplateFamilyId: string;
  name: string;
  isDefault: boolean;
  status: TemplateTypeStatus;
  activeVersionNo: number | null;     // the ACTIVE (or default) settings version
  activeSince: Date | null;           // its activated_datetime
  retiredAt: Date | null;
}
```

### 4. Repositories

**`db/repositories/billing/bill-template-family.ts`:**
- Update the header comment to say `app_runtime` may now INSERT and UPDATE.
- **Add** these functions:
  - `listAll(db): Promise<BillTemplateFamily[]>`: the default first, then by `name`.
  - `findByNameCi(db, name): Promise<BillTemplateFamily | null>`: `WHERE lower(btrim(name)) = lower(btrim($1))`, retired included.
  - `codeExists(db, code): Promise<boolean>`.
  - `insertType(tx, { code, name, layoutCode, createdBy }): Promise<BillTemplateFamily>`: `kind = 'generated'`, `is_default = false`.
  - `listUsable(db)`, the build plan's just-in-time item for cm23 (CM workflow rules §10.6.2: Customer Management consumes the type repository, never edits it):
    ```ts
    // bm77 — the types a BAN may be bound to, besides Standard (which is NULL): not default,
    // not retired, with a non-default ACTIVE settings version. By name ascending. Read by
    // Customer Management's listBindableTemplateTypes (cm23) and the retire target picker (bm83).
    async listUsable(db: Database): Promise<{ billTemplateFamilyId: string; name: string }[]>
    // SELECT btf.bill_template_family_id, btf.name FROM billing.bill_template_family btf
    // WHERE NOT btf.is_default AND btf.retired_datetime IS NULL
    //   AND EXISTS (SELECT 1 FROM billing.bill_template_version v
    //               WHERE v.ref_bill_template_family_id = btf.bill_template_family_id
    //                 AND v.kind = 'generated' AND v.status = 'ACTIVE' AND NOT v.is_default)
    // ORDER BY btf.name
    ```
- Per General rule 9, there is **no** function that updates `name`, `code` or `layout_code`.

**`db/repositories/billing/bill-template-version.ts`:**
- `nextVersionNo(tx, { kind, familyId })`: `familyId` becomes **required** for `kind` `layout` and `generated` (a type-level `max + 1`); CSV keeps the per-format max.
- **Add** `listActiveSettingsByFamily(db): Promise<Map<string, { versionNo: number; activatedDatetime: Date | null }>>`: for each type, its non-default ACTIVE `generated` row, else its default. One query, used by the list.
- Update the comments that name bm74's constraints (bm74 §4 already corrected them).

### 5. Services

**`services/billing/invoice-template/template-types.ts` (new):**

```ts
export function normalizeTemplateTypeName(raw: string): string; // trim + collapse whitespace
export function deriveTemplateTypeCode(name: string): string;     // rules in Design
export function deriveTemplateTypeStatus(
  type: Pick<BillTemplateFamily, "retiredDatetime">,
  hasActiveSettings: boolean,
): TemplateTypeStatus;

export type CreateTemplateTypeResult =
  | { ok: true; typeId: string; code: string; layoutCode: string }
  | { ok: false; code: TemplateTypeErrorCode; fieldErrors?: Record<string, string[]> };

export async function createTemplateType(
  input: { name: string },
  actorId: string,
): Promise<CreateTemplateTypeResult>;
```

`createTemplateType` steps:
1. `name = normalizeTemplateTypeName(input.name)`.
2. `templateTypeNameSchema.safeParse(name)`; a failure → `TEMPLATE_TYPE_NAME_INVALID` with `fieldErrors.name`.
3. `findByNameCi(db, name)`; a hit → `TEMPLATE_TYPE_NAME_TAKEN` (`fieldErrors.name = ["An invoice template type with this name already exists (names of retired types stay reserved)."]`).
4. Up to 5 attempts, each in a `db.transaction`:
   - work out the candidate code: `base`, `base_2`, `base_3`…, skipping any `codeExists`
   - `insertType(tx, { code, name, layoutCode: "INVTPL-" + code, createdBy: actorId })`
   - `insertAuditEvent(tx, { eventType: "INVOICE_TEMPLATE_TYPE_CREATED", actorUserId: actorId, targetEntity: "BILL_TEMPLATE_FAMILY", targetId, beforeData: null, afterData: { name, code, layoutCode } })`

   A `23505` on `btf_name_ci_uq` → `TEMPLATE_TYPE_NAME_TAKEN`. On `btf_code_uq` or `btf_layout_code_uq`, try the next suffix. Any other error is rethrown.
5. Return `{ ok: true, … }`.

**`services/billing/read/invoice-template-settings.ts` (changed):**
- **Add** `listTemplateTypes(): Promise<TemplateTypeListRow[]>`: `listAll` joined with `listActiveSettingsByFamily`, with status from `deriveTemplateTypeStatus`.
- **`getInvoiceTemplatePageData`** becomes `(typeId: string, versionId: string | undefined, { canEdit })`:
  - `findById(db, typeId)` replaces `findDefault`; `null` → return `null` (the page calls `notFound()`)
  - `standardFamilyId` and `standardFamilyName` are renamed `typeId` and `typeName`
  - add `typeStatus: TemplateTypeStatus`, `isDefaultType: boolean`, `layoutCode: string` and `nextLayoutVersionNo: number` (`max` over the type's layout rows + 1, or 1)
- **A type with no settings at all** (`active ?? fallback` is null) **no longer throws.** It returns `current: null` with an empty `history`, and the page renders the empty state. This is the "Not yet usable" case.
- `shown` keeps its type check (`selected.refBillTemplateFamilyId === typeId`).

**`last_modified_by` on every settings-DRAFT write (D128):** `billTemplateVersionRepository.updateDraftStructure` gains `actorId` and sets `last_modified_by = actorId` alongside `last_modified_datetime = now()`. `insertDraft` sets `last_modified_by` (and `created_by`) to the saver. `saveTemplateDraft` passes `actorId` to both. bm78 and bm80 reuse the same repository functions, so every DRAFT write records its last writer.

**`services/billing/invoice-template/save-template-draft.ts`:**
- Step 4 uses `billTemplateFamilyRepository.findById(tx, input.familyId)`; `null` → `DRAFT_CONFLICT`.
- `nextVersionNo(tx, { kind: "generated", familyId })`.
- A type with no current settings to copy from returns the existing `TEMPLATE_VERSION_NOT_FOUND`. The UI never offers the form for such a type.

**`services/billing/invoice-template/activate-template.ts`:**
- Step 2 replaces `findDefault` with `findById(db, input.familyId)` and `findDraft({ kind: "generated", familyId: input.familyId })`.
- Step 8 asserts `locked.refBillTemplateFamilyId === input.familyId`, else `DRAFT_CONFLICT`.
- The blob path is unchanged (see the Design note for bm79).

### 6. Actions

- **`create-template-type.action.ts` (new):** `"use server"`.
  1. `requirePermission(PERMISSIONS.INVOICE_SETTINGS, LEVELS.EDIT)` is the first statement in `try`; a redirect error → `FORBIDDEN`.
  2. `createTemplateTypeInputSchema.safeParse` → `VALIDATION_ERROR`.
  3. `createTemplateType`.
  4. On success, `revalidatePath("/administration/invoice-settings", "layout")` and return `{ ok: true, typeId }`. The dialog then navigates to `/administration/invoice-settings/invoice-template/${typeId}`.
  5. A thrown error → `logger.error`, then `SERVER_ERROR`.

  The result union is `{ ok: true; typeId } | { ok: false; code: "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR" | TemplateTypeErrorCode; fieldErrors? }`.
- **`save-template-draft.action.ts` and `activate-template.action.ts`:** no change beyond passing the new `familyId` field, which their schemas now require.

### 7. Pages

**`app/(app)/administration/invoice-settings/invoice-template/page.tsx` (rewritten: the type list):**
- `requirePermission(INVOICE_SETTINGS, READ)` and `canEdit` as today.
- If the search params carry `tab` or `version`: `redirect` to `/administration/invoice-settings/invoice-template/${defaultTypeId}?…`, the same query (old bookmarks).
- `<InvoiceSettingsTabs active="invoice-template" />`, then `<h2>Invoice template types</h2>` (`--text-h2`).
- If `canEdit`, `<CreateTemplateTypeDialog />` with a primary **"New invoice template type"** trigger.
- `<TemplateTypeList rows={await listTemplateTypes()} showRetired={params.retired === "1"} />`.

**`app/(app)/administration/invoice-settings/invoice-template/[typeId]/page.tsx` (new; the body of today's page):**
- The guard and `canEdit` / `canPreviewBills` as today.
- `templateTypeIdParamSchema.safeParse(params.typeId)`; a failure or a `null` page data → `notFound()`.
- A back link "← All invoice template types".
- Heading `Invoice template type — {typeName}`, with "(default)" in `--text-muted` only when `isDefaultType`. Then `v{shown.versionNo}` and `<TemplateVersionStatusBadge status={typeStatus} isDefault={isDefaultType} />`.
- A key–value row in `--text-body-sm`: **Layout code** `{layoutCode}` (mono) · **Next layout version** `v{nextLayoutVersionNo}` (mono).
- **`current === null` (Not yet usable):** the ui-context §10e Info alert, "No layout uploaded yet. Upload a layout package to create the first draft." No tabs body. bm78 adds the Upload button here.
- **Otherwise:** today's three tabs, unchanged, with `familyId={data.typeId}` passed to `InvoiceStructureForm` and the action calls.

`[typeId]/loading.tsx` and `[typeId]/error.tsx` are moved from today's page unchanged (the heading "Unable to load the invoice template" is kept). The old `invoice-template/loading.tsx` and `error.tsx` stay for the list, with the skeleton caption changed to "Loading invoice template types…".

### 8. Components (`components/billing/invoice-settings/`)

- **`template-type-list.tsx` (new, server):** a `Table` (`--radius-none`) with these columns:
  - **Name:** a link to the detail page
  - **Status:** the §10a badge, plus the Default chip on Standard
  - **Active version:** `v{n}` in mono, or "—"
  - **Active since:** formatted with `formatDatetime`, or "—"

  Retired rows are hidden unless `showRetired`. A "Show retired types" `Link` toggles `?retired=1`. With no rows beyond Standard there's no special empty state, because Standard always exists.
- **`create-template-type-dialog.tsx` (new, client):** a `Dialog` with one `Input` labelled **"Name"** (the hint "3–60 letters, digits, spaces, & ( ) or -. The name can't be changed later."), and **Create** (primary) and **Cancel** buttons.
  - On `ok: false` it shows `fieldErrors.name` under the input in Danger `-fg`.
  - On success it `router.push`es to the detail page.
  - Client-side, it trims and checks the length before enabling Create (UX only).
- **`template-version-status-badge.tsx` (changed):** the `status` prop accepts `TemplateVersionStatus | TemplateTypeStatus`.
  - The cva variants add `USABLE` (the ACTIVE classes, label "Usable", `CircleCheck`) and `NOT_YET_USABLE` (the DRAFT classes, label "Not yet usable", `PencilLine`).
  - `RETIRED` is shared.
  - It stays the one status component.
- **`template-type-messages.ts` (new):** the strings above (empty state, name hint, name-taken message, back-link text), defined once.

### 9. Audit catalogue

- **`types/audit.ts`:** add `"INVOICE_TEMPLATE_TYPE_CREATED"` to `AUDIT_EVENT_TYPES`.
- **`types/audit-log.ts`:** add `INVOICE_TEMPLATE_TYPE_CREATED: "Additive"` to `AUDIT_EVENT_CATEGORY_MAP`.
- **`tests/components/audit-log-filters.test.tsx:218`:** the option count goes 88 → 89.

### 10. Navigation

- No registry change: `/administration/invoice-settings` stays the one entry.
- The list route `/administration/invoice-settings/invoice-template` keeps its `UNLISTED_BY_DESIGN` reason in `tests/guardrails/nav-registry-guard.test.ts`. The `[typeId]` route is dynamic, so the guard skips it.

### 11. Tests

**New:**
- **`tests/services/billing/invoice-template/template-types.test.ts`:**
  - `normalizeTemplateTypeName("  Whole   sale ")` → `"Whole sale"`
  - `deriveTemplateTypeCode` cases: "Wholesale" → `WHOLESALE`, "Wholesale & Retail (East)" → `WHOLESALE_RETAIL_EAST`, "5G Enterprise" → `T_5G_ENTERPRISE`, a 60-character name → at most 60 characters
  - `deriveTemplateTypeStatus` in all three states
- **`tests/db/template-types-create.integration.test.ts`** (DB-gated, run as `app_runtime` where the harness allows; otherwise grants asserted over `information_schema`):
  - creating "Wholesale" → a row with `code WHOLESALE`, `layout_code INVTPL-WHOLESALE`, no version rows, and one `INVOICE_TEMPLATE_TYPE_CREATED` row
  - creating "wholesale", " Wholesale " and "WHOLESALE" → `TEMPLATE_TYPE_NAME_TAKEN`
  - after retiring the row via SQL, creating "Wholesale" → still taken
  - creating "Wholesale 2" (derived code `WHOLESALE_2`) when that code is free → the `WHOLESALE_2` row
  - the collision path: pre-insert a type with code `ACME`, then create "Acme" (a free name) → `ACME_2`
  - **grants:** `app_runtime` has `INSERT` and `UPDATE` and not `DELETE` on `bill_template_family`, and `USAGE` on `bill_template_family_seq` (guardrail 79, grant half)
  - `listUsable` returns a non-default type with an ACTIVE settings row (inserted via SQL), and omits Standard, a retired type, and a type with only DRAFT or RETIRED rows
- **`tests/app/invoice-template-types-page.test.tsx`:**
  - the list renders Standard as Usable + Default
  - a created type shows Not yet usable
  - a READ user sees no "New invoice template type"
  - `?tab=history&version=BTV…` redirects to Standard's detail page with the same query
- **`tests/app/invoice-template-type-detail-page.test.tsx`:**
  - Standard's page renders today's tabs and heading (with "(default)"), Layout code `INVTPL-STD-A4` and Next layout version `v2`
  - a Not-yet-usable type renders the Info empty state and no tabs body
  - an unknown or malformed `typeId` → `notFound()`
  - `?version=` of another type falls back to the type's own version

**Changed:**
- **Today's page tests for `invoice-template/page.tsx`** move to the `[typeId]` detail test. Their assertions stay, apart from the heading text ("Invoice template type — Standard (default)").
- **`tests/db/save-template-draft.integration.test.ts`:**
  - inputs carry `familyId: "BTF00000001"`
  - add: a draft saved for Standard gets `version_no` = Standard's max + 1
  - add: a `familyId` that doesn't exist → `DRAFT_CONFLICT`
- **`tests/db/activate-template.integration.test.ts`:**
  - inputs carry `familyId`
  - add: activating with a `familyId` other than the draft's → `DRAFT_CONFLICT`, and nothing changes
- **`tests/guardrails/invoice-settings-authz-matrix.test.ts`:**
  - new rows: the list page (READ, page), the `[typeId]` detail page (READ, page), `create-template-type.action.ts` (EDIT, action)
  - the source-order checks at lines 206/233/260 keep passing with the new schema field
- **`tests/components/audit-log-filters.test.tsx`:** 89 options.

## Dependencies

- **Packages:** none.
- **Units:** **bm74** (the `layout_code` column, `btf_name_ci_uq`, the code/name CHECKs and the type guard).
- **Environment:** run the bootstrap roles script on the disposable test database after `0053`, the existing `db:setup` order.

## Verification checklist

- [ ] The list shows Standard as **Usable** with the Default chip. "New invoice template type" creates "Wholesale", which appears as **Not yet usable** and opens its empty detail page.
- [ ] A duplicate name in any case or spacing, including a retired one, shows the name-taken field error and writes nothing. An invalid name shows the format error.
- [ ] Standard's detail page edits the Payment toggle and footnote, previews and activates exactly as before (the save-draft and activate suites are green with `familyId`).
- [ ] A new Standard settings draft is numbered Standard's max + 1, and `nextVersionNo` requires `familyId` for layout and generated.
- [ ] `getInvoiceTemplatePageData`, `saveTemplateDraft` and `activateTemplate` contain no `findDefault` call for the family (grep).
- [ ] `app_runtime`: INSERT/UPDATE yes, DELETE no on `bill_template_family`; USAGE on its sequence (guardrail 79, grant half).
- [ ] `INVOICE_TEMPLATE_TYPE_CREATED` is in the audit catalogue and category map. One row per create.
- [ ] Old `?tab=…&version=…` links on the list redirect to Standard's detail page.
- [ ] The authz matrix, nav-registry guard, audit-filters and every changed test pass. `tsc --noEmit`, ESLint and Prettier pass.
- [ ] Docs: `billmgmt-code-standards.md` permission map rows for the list, detail and create are marked "built (bm77)". `billmgmt-architecture.md` T7 (the grant) is marked "built (bm77)". `billmgmt-progress-tracker.md` records bm77.
