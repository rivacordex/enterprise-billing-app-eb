import { InvoiceTemplateLoadingSkeleton } from "@/components/billing/invoice-settings/invoice-template-loading-skeleton";

// bm55-spec §Implementation 4 — the type detail page's skeleton, captioned as
// the preview's loading state.
export default function Loading(): React.JSX.Element {
  return <InvoiceTemplateLoadingSkeleton caption="Rendering draft invoice…" />;
}
