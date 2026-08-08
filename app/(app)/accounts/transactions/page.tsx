import { Suspense } from "react";
import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { meetsLevel } from "@/types/permissions";
import { ApprovalBanner } from "@/components/accounts/approval-banner";
import { ClosurePanel } from "@/components/accounts/closure-panel";
import { DocumentDetailDrawer } from "@/components/accounts/document-detail-drawer";
import { ContextStrip } from "@/components/accounts/context-strip";
import {
  DocumentsTable,
  DOCUMENTS_PAGE_SIZE,
} from "@/components/accounts/documents-table";
import { TransactionsActionBar } from "@/components/accounts/transactions-action-bar";
import {
  getBillingAccountClosureEligibility,
  getFinancialAccountClosureEligibility,
} from "@/services/accounts/closure-eligibility";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import {
  getRefundWorkbenchData,
  listPendingApprovals,
} from "@/services/accounts/get-transactions-context";
import { getTransactionDocumentDetail } from "@/services/accounts/get-transaction-document-detail";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";
import { transactionsSearchParamsSchema } from "@/validation/accounts/transactions-search-params.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Transactions" };

function firstStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { userId, permissionMap } = await requirePermission(
    PERMISSIONS.ACCOUNTS_TRANSACTIONS,
    LEVELS.READ,
  );
  const canEdit = meetsLevel(
    permissionMap[PERMISSIONS.ACCOUNTS_TRANSACTIONS],
    LEVELS.EDIT,
  );

  const raw = await searchParams;
  const ctx = parseAccountsContext(raw);

  // Transactions workbench search params (type/status/rev/q/sort/page/doc).
  // ?party/fa/ban are parsed only by parseAccountsContext (code-standards §3.1).
  const parsed = transactionsSearchParamsSchema.parse({
    type: firstStr(raw.type) ?? null,
    status: firstStr(raw.status) ?? null,
    rev: firstStr(raw.rev) ?? null,
    q: firstStr(raw.q) ?? "",
    sort: firstStr(raw.sort),
    page: firstStr(raw.page) ?? 1,
    doc: firstStr(raw.doc) ?? null,
  });

  const [locale, timezone, faDetail, banDetail] = await Promise.all([
    getAppLocale(),
    Promise.resolve(getAppTimezone()),
    ctx.fa ? getFinancialAccountDetail(ctx.fa) : null,
    ctx.ban ? getBillingAccountDetail(ctx.ban) : null,
  ]);

  const [
    pendingApprovals,
    refundData,
    banEligibility,
    faEligibility,
    docsPage,
    docDetail,
  ] = await Promise.all([
    // listPendingApprovals retained — banner count uses it (§2.7).
    canEdit && ctx.fa ? listPendingApprovals(ctx.fa) : Promise.resolve([]),
    canEdit && ctx.fa && ctx.ban
      ? getRefundWorkbenchData(ctx.fa, ctx.ban)
      : Promise.resolve({
          assignedItems: [],
          unappliedCashAvailable: "0.00",
        }),
    canEdit && ctx.ban
      ? getBillingAccountClosureEligibility(ctx.ban).catch(() => null)
      : Promise.resolve(null),
    canEdit && ctx.fa
      ? getFinancialAccountClosureEligibility(ctx.fa).catch(() => null)
      : Promise.resolve(null),
    // Document list — FA-scoped when no BAN, BAN+null-BAN when BAN present (§2.2).
    ctx.fa
      ? listTransactionDocuments(
          ctx.fa,
          ctx.ban ?? null,
          {
            type: parsed.type,
            status: parsed.status,
            rev: parsed.rev,
            q: parsed.q,
            sort: parsed.sort,
            page: parsed.page,
          },
          DOCUMENTS_PAGE_SIZE,
        )
      : Promise.resolve({ rows: [], total: 0 }),
    // Document detail drawer — loaded only when ?doc is present (ac21-spec §3.4).
    // Catch to null (like the closure-eligibility loads above) so a detail-load
    // failure omits only the drawer; the table still renders.
    parsed.doc && ctx.fa
      ? getTransactionDocumentDetail(parsed.doc, ctx.fa).catch(() => null)
      : Promise.resolve(null),
  ]);

  const banClosure =
    banEligibility && banEligibility.ok && banEligibility.eligible
      ? { eligible: true as const, openReceivable: "0.00" }
      : banEligibility && banEligibility.ok && !banEligibility.eligible
        ? {
            eligible: false as const,
            openReceivable: banEligibility.openReceivable,
          }
        : null;

  const faClosure =
    faEligibility && faEligibility.ok && faEligibility.eligible
      ? {
          eligible: true as const,
          unappliedCash: "0.00",
          deposits: "0.00",
          openBillingAccountIds: [] as string[],
        }
      : faEligibility && faEligibility.ok && !faEligibility.eligible
        ? {
            eligible: false as const,
            unappliedCash: faEligibility.unappliedCash,
            deposits: faEligibility.deposits,
            openBillingAccountIds: faEligibility.openBillingAccountIds,
          }
        : null;

  // Overview link for the empty-state — preserves context params (inv. #17).
  const overviewParams = new URLSearchParams();
  if (ctx.party) overviewParams.set("party", ctx.party);
  if (ctx.fa) overviewParams.set("fa", ctx.fa);
  if (ctx.ban) overviewParams.set("ban", ctx.ban);
  const overviewHref = `/accounts/overview${overviewParams.size > 0 ? `?${overviewParams.toString()}` : ""}`;

  // closeDocHref — all current params except ?doc, preserving context and
  // filters/sort/page so closing the drawer does not reset the table (§2.1).
  const closeDocParams = new URLSearchParams();
  if (ctx.party) closeDocParams.set("party", ctx.party);
  if (ctx.fa) closeDocParams.set("fa", ctx.fa);
  if (ctx.ban) closeDocParams.set("ban", ctx.ban);
  if (parsed.type) closeDocParams.set("type", parsed.type);
  if (parsed.status) closeDocParams.set("status", parsed.status);
  if (parsed.rev) closeDocParams.set("rev", parsed.rev);
  if (parsed.q) closeDocParams.set("q", parsed.q);
  if (parsed.sort !== "-event_at") closeDocParams.set("sort", parsed.sort);
  if (parsed.page !== 1) closeDocParams.set("page", String(parsed.page));
  const closeDocQs = closeDocParams.toString();
  const closeDocHref = `/accounts/transactions${closeDocQs ? `?${closeDocQs}` : ""}`;

  // ac22-spec §3.3 — drawer reversal eligibility, mirroring ac20's `reversible`
  // derivation (inv. #18): posted with at least one unreversed line. Computed
  // here from the detail the page already loaded; the service re-validates on
  // submit. The drawer only renders when ctx.fa is set (docDetail requires it).
  const drawerReversible =
    docDetail?.ok === true &&
    docDetail.detail.document.state === "posted" &&
    docDetail.detail.lines.some((l) => l.line.reversedByLineId === null);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Transactions</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Documents raised against the selected context.
        </p>
      </header>

      <ContextStrip
        party={ctx.party}
        partyName={faDetail?.relatedParty[0]?.name}
        fa={ctx.fa}
        faName={faDetail?.fa.name}
        ban={ctx.ban}
        banName={banDetail?.ban.name}
      />

      {!canEdit && (
        <p className="text-body-sm text-muted-foreground">
          You have read-only access to Transactions.
        </p>
      )}

      {/* Approval banner — above filters per §2.7 (SC11). Suspense required
          for useSearchParams() inside the client component. */}
      {canEdit && ctx.fa && (
        <Suspense>
          <ApprovalBanner count={pendingApprovals.length} />
        </Suspense>
      )}

      {canEdit && (
        <TransactionsActionBar
          financialAccountId={ctx.fa}
          billingAccountId={ctx.ban}
          assignedItems={refundData.assignedItems}
          unappliedCashAvailable={refundData.unappliedCashAvailable}
        />
      )}

      {/* Documents table — shown for both READ and EDIT; Suspense for
          useSearchParams() (inv. #17 filter state in URL). */}
      <Suspense>
        <DocumentsTable
          rows={docsPage.rows}
          total={docsPage.total}
          page={parsed.page}
          pageSize={DOCUMENTS_PAGE_SIZE}
          sort={parsed.sort}
          type={parsed.type}
          status={parsed.status}
          rev={parsed.rev}
          q={parsed.q}
          locale={locale}
          timezone={timezone}
          overviewHref={overviewHref}
          financialAccountId={ctx.fa}
          canEdit={canEdit}
        />
      </Suspense>

      {/* Document detail drawer — URL-driven, inv. #17. Only when ?doc resolves
          to a valid document that belongs to the context FA (§2.6). */}
      {docDetail?.ok && ctx.fa && (
        <DocumentDetailDrawer
          detail={docDetail.detail}
          closeHref={closeDocHref}
          locale={locale}
          timezone={timezone}
          canEdit={canEdit}
          currentUserId={userId}
          financialAccountId={ctx.fa}
          reversible={drawerReversible}
        />
      )}

      {canEdit && (
        <ClosurePanel
          ban={
            banDetail
              ? {
                  billingAccountId: banDetail.ban.billingAccountId,
                  state: banDetail.ban.state,
                  lastModified: banDetail.ban.lastModified,
                  currency: banDetail.ban.currency,
                }
              : null
          }
          banClosure={banClosure}
          fa={
            faDetail
              ? {
                  financialAccountId: faDetail.fa.financialAccountId,
                  state: faDetail.fa.state,
                  lastModified: faDetail.fa.lastModified,
                  currency: faDetail.fa.currency,
                }
              : null
          }
          faClosure={faClosure}
        />
      )}
    </main>
  );
}
