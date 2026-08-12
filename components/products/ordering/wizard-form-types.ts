import type { PriceType } from "@/types/product";

// pm29-spec §Implementation-2. The UI-only shape backing the wizard's Step 3
// react-hook-form instance (Design — "local zodResolver on createOrderSchema
// (fast-fail)"). `characteristicsList`/`overrides` are array-shaped for
// `useFieldArray`; they translate to `createOrderSchema`'s
// `characteristics`/`overrides` record/array shapes only at submit — the
// same local-schema-plus-translation pattern `price-form.tsx`/
// `specification-form.tsx` already use.
export type WizardFormValues = {
  quantity: number;
  startDate: string;
  characteristicsList: { key: string; value: string }[];
  overrides: { priceType: PriceType; amount: string }[];
};
