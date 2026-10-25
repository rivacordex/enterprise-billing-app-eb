import { InvoiceTemplateLoadingSkeleton } from "@/components/billing/invoice-settings/invoice-template-loading-skeleton";

// bm77 — this route is now the type list, so the caption says so (the
// `[typeId]` detail page keeps the "Rendering draft invoice…" copy).
export default function Loading(): React.JSX.Element {
  return (
    <InvoiceTemplateLoadingSkeleton caption="Loading invoice template types…" />
  );
}
