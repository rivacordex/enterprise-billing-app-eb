# rm17 — `perUnitRateDetailSchema` — Spec

- **Unit:** rm17 of Phase G (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` · **Boundary:** `validation/rating/udr-rate-detail.schema.ts` + its test
- **Authorizes from:** `_change-rating-configuration-plan.md` (A3, explicit `PER_UNIT` rate detail); `ratemgmt-code-standards.md` §0, §2.3 (JSONB Zod-validated, discriminated by `udr_rate_type`).

## Goal

Add the `PER_UNIT` variant to the `udr_rate_detail` discriminated union so RP (rm19) can emit and RL can carry a self-describing PER_UNIT rate detail; the schema is the exact contract the `rp.py` Python mirror must match field-for-field.

## Design

- **Additive to the existing discriminated union.** Today `udr-rate-detail.schema.ts` holds `flatRateDetailSchema = z.object({ rateType: z.literal("FLAT") })` and `udrRateDetailSchema = z.discriminatedUnion("rateType", [flatRateDetailSchema])`. Adding a `PER_UNIT` branch is a **validation change, not a migration** — the column and its `.$type<UdrRateDetail>()` already exist; the union just gains a member. `FLAT` is untouched.
- **Explicit / self-describing (the plan's choice).** Unlike `FLAT` (which carries only the discriminant because its inputs live in dedicated columns), `PER_UNIT` carries `ratePerUnit`, `quantity` and `amountRaw` — deliberately redundant with `udr_usage_rate` / `udr_usage_quantity` / `udr_rated_price_raw`, so the detail reads as a complete calculation record.
- **Money/decimal are `string`** (§2.15). **Reuse the existing money-string validator** the `usage_rate` component uses (`validation/product/pricing-component.schema.ts`) — do not reinvent a divergent regex.
- **RL does not re-validate** `udr_rate_detail` (it carries it as opaque text), so RP's emission against this schema is the only guard — the schema must be the precise contract, and rm19's Python mirror must match it exactly.

## Implementation

### 1. Add the `PER_UNIT` branch (`validation/rating/udr-rate-detail.schema.ts`)
```ts
export const perUnitRateDetailSchema = z.object({
  rateType: z.literal("PER_UNIT"),
  ratePerUnit: moneyString,   // numeric(18,6) as string — the resolved usage_rate ratePerUnit
  quantity:    decimalString, // usage_volume as string — numeric(20,6)
  amountRaw:   moneyString,    // ratePerUnit × quantity, pre-rounding — numeric(18,6)
});

export const udrRateDetailSchema = z.discriminatedUnion("rateType", [
  flatRateDetailSchema,
  perUnitRateDetailSchema,
]);
```

### 2. `moneyString` / `decimalString`
Reuse the existing money-string schema from the validation layer (confirm the exported name in `validation/product/pricing-component.schema.ts`). If no shared export exists, add one shared `moneyString = z.string().regex(/^-?\d+(\.\d{1,6})?$/)` and use it in both places — a single validator, never two regexes that can drift. `decimalString` follows the same shape for `quantity`.

### 3. Type flows through automatically
`UdrRateDetail = z.infer<typeof udrRateDetailSchema>` now includes the `PER_UNIT` variant; the `.$type<UdrRateDetail>()` on `udr_rated.udr_rate_detail` (Drizzle) picks it up — no schema-`.ts` change needed there.

### 4. Test (`tests/validation/udr-rate-detail.schema.test.ts` or the module's existing rate-detail test)
- A valid `PER_UNIT` detail (`{ rateType:"PER_UNIT", ratePerUnit:"100.000000", quantity:"20", amountRaw:"2000.000000" }`) parses.
- `FLAT` still parses.
- An extra key, a missing field, a number-typed (non-string) money, or a wrong discriminant is rejected.

## Dependencies

**None.** `zod` is already a dependency; this is a pure schema addition.

## Verification checklist

- [ ] `perUnitRateDetailSchema` parses the valid example and rejects extra-key / missing-field / non-string-money / wrong-discriminant inputs.
- [ ] `flatRateDetailSchema` still parses (`FLAT` untouched).
- [ ] `ratePerUnit`/`amountRaw` use the **same** money-string validator as the `usage_rate` component — one regex, not a new one.
- [ ] `UdrRateDetail` (inferred) includes both variants; the Drizzle column type compiles.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; the schema test is green.
- [ ] Diff is `validation/rating` + test only. *(Python-mirror parity is asserted in rm19 — cross-repo, not here.)*
