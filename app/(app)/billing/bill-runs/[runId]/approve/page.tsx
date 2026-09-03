import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ApproveAndPostPanel } from "@/components/billing/approve-and-post-panel";
import { PostingProgressView } from "@/components/billing/posting-progress-view";
import { PlaceholderBanner } from "@/components/billing/placeholder-banner";
import { isBillrunPlaceholderMode } from "@/lib/config";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import { getApprovePreview } from "@/services/billing/read/get-approve-preview";
import { getPostingProgress } from "@/services/billing/read/get-posting-progress";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm10-spec §Implementation §3, code-standards §3.1/§3.6/§8. Guard
// (billrun_approve:EDIT) → parse `[runId]` → read the live preview → render.
// Uncached (Inv. #12) — the checklist must reflect the run's current state.
// bm11 extends this route rather than adding a new one: once the run leaves
// `PROCESSED` (approved or beyond), the same route renders `PostingProgressView`
// instead of the approve checklist — the "Reached from the Approve & Post
// confirm (approve → post)" flow is this page re-rendering after
// `router.refresh()` sees the run is now `APPROVED`.
export const dynamic = "force-dynamic";

interface ApproveAndPostPageProps {
  params: Promise<{ runId: string }>;
}

export async function generateMetadata({
  params,
}: ApproveAndPostPageProps): Promise<Metadata> {
  const { runId } = await params;
  return { title: `Approve & Post — ${runId}` };
}

export default async function ApproveAndPostPage({
  params,
}: ApproveAndPostPageProps): Promise<React.JSX.Element> {
  const { userId } = await requirePermission(
    PERMISSIONS.BILLRUN_APPROVE,
    LEVELS.EDIT,
  );

  const { runId: rawRunId } = await params;
  const idResult = billRunIdSchema.safeParse(rawRunId);
  if (!idResult.success) {
    notFound();
  }

  const preview = await getApprovePreview(idResult.data, userId);
  if (!preview) {
    notFound();
  }

  if (preview.status !== "PROCESSED") {
    const progress = await getPostingProgress(idResult.data);
    if (!progress) {
      notFound();
    }
    return (
      <main className="space-y-6 p-6">
        {isBillrunPlaceholderMode && <PlaceholderBanner />}
        <PostingProgressView
          progress={progress}
          cycleName={preview.cycleName}
          periodStart={preview.periodStart}
          periodEnd={preview.periodEnd}
        />
      </main>
    );
  }

  const locale = await getAppLocale();
  const timezone = getAppTimezone();

  const totalAmountDisplay = preview.currency
    ? formatCurrency(preview.totalAmount, preview.currency, locale)
    : preview.totalAmount;
  const triggeredAtDisplay = formatDatetime(
    preview.triggeredAt,
    locale,
    timezone,
    "an unknown time",
  );

  return (
    <main className="space-y-6 p-6">
      {isBillrunPlaceholderMode && <PlaceholderBanner />}
      <ApproveAndPostPanel
        preview={preview}
        triggeredAtDisplay={triggeredAtDisplay}
        totalAmountDisplay={totalAmountDisplay}
      />
    </main>
  );
}
