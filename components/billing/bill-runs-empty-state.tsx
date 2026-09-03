import { ReceiptText } from "lucide-react";

// bm01-spec §5 (Design): the Bill Runs scaffold empty state — a centered card
// on `--surface-app`, mirroring the card/typography pattern of
// `app/(app)/no-access/page.tsx`. Server component (no interaction); the run
// list, PlaceholderBanner, and Run CTA arrive in bm02/bm03.
export function BillRunsEmptyState(): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-[color:var(--surface-app)] px-4 py-16">
      <div className="w-full max-w-[440px] rounded-lg bg-card p-8 text-center shadow-sm">
        <ReceiptText
          aria-hidden
          className="mx-auto mb-4 size-12 text-[color:var(--text-muted)]"
        />
        <h2 className="text-h3 font-semibold text-foreground">
          No bill runs yet
        </h2>
        <p className="mt-2 text-body text-[color:var(--text-muted)]">
          Bill runs appear here once a billing cycle is due. Nothing to run yet.
        </p>
      </div>
    </div>
  );
}
