import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle, History, Upload } from "lucide-react";

import { firstValue } from "@/lib/search-params";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ActivateVersionDialog } from "@/components/products/rate-card/activate-version-dialog";
import { buildRateCardHref } from "@/components/products/rate-card/rate-card-href";
import { RateCardDiffPanel } from "@/components/products/rate-card/rate-card-diff-panel";
import { RateCardRowPreview } from "@/components/products/rate-card/rate-card-row-preview";
import { RateCardStatusBadge } from "@/components/products/rate-card/rate-card-status-badge";
import { RollbackVersionDialog } from "@/components/products/rate-card/rollback-version-dialog";
import { UploadVersionDialog } from "@/components/products/rate-card/upload-version-dialog";
import { RateCardVersionTable } from "@/components/products/rate-card/rate-card-version-table";
import { getRateCardVersionDiff } from "@/services/product/ratecard/get-version-diff";
import { getRateCardVersionRows } from "@/services/product/ratecard/get-version-rows";
import { listRateCardVersions } from "@/services/product/ratecard/list-versions";
import {
  getAppLocale,
  getAppName,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { formatCalendarDate } from "@/lib/formatters";
import { meetsLevel } from "@/types/permissions";
import type { RatecardVersion } from "@/types/product";
import { rateCardListSearchParamsSchema } from "@/validation/product/ratecard-list.schema";

// pm65 D12 / pm66 — no cache anywhere on this page (Inv. #59, guardrail 40):
// `force-dynamic`, and no `unstable_cache`/`revalidate`/`cache()`/module store
// around any card read.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `Rate Card — ${await getAppName()}` };
}

const TABS = [
  { key: "rows", label: "Rows" },
  { key: "diff", label: "Diff vs Active" },
  { key: "validation", label: "Validation" },
] as const;

// Middle-truncate a checksum for the metadata strip (ui-context §10.5:
// `a91f…3c02`). Short values render whole.
function truncateChecksum(checksum: string | null): string {
  if (checksum === null || checksum === "") return "—";
  if (checksum.length <= 10) return checksum;
  return `${checksum.slice(0, 4)}…${checksum.slice(-4)}`;
}

const UPLOAD_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-primary-bg)] px-3 py-2 text-body-sm font-semibold text-white hover:bg-[color:var(--action-primary-bg-hover)]";
const VERSION_ACTION_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-[color:var(--action-secondary-border)] bg-[color:var(--action-secondary-bg)] px-3 py-2 text-body-sm font-semibold text-[color:var(--action-secondary-text)] hover:bg-[color:var(--action-ghost-hover)]";

export default async function RateCardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // ratecard:READ gates the whole read surface; the map decides whether the
  // EDIT-only controls (upload/activate/rollback) render at all (D11 — absent,
  // not disabled). The action guards remain the boundary regardless.
  const { permissionMap } = await requirePermission(
    PERMISSIONS.RATECARD,
    LEVELS.READ,
  );
  const canEdit = meetsLevel(permissionMap.ratecard, LEVELS.EDIT);

  const raw = await searchParams;
  const params = rateCardListSearchParamsSchema.parse({
    version: firstValue(raw.version) ?? null,
    page: firstValue(raw.page) ?? 1,
    q: firstValue(raw.q),
    tab: firstValue(raw.tab),
  });

  const timezone = getAppTimezone();

  const [versions, locale] = await Promise.all([
    listRateCardVersions(),
    getAppLocale(),
  ]);

  const selectedVersion: RatecardVersion | null =
    params.version !== null
      ? (versions.find((v) => v.ratecardVersionId === params.version) ?? null)
      : null;
  const selectedVersionId = selectedVersion?.ratecardVersionId ?? null;
  const versionNotFound = params.version !== null && selectedVersion === null;

  // The card's current ACTIVE version (the one a "removed" key stays held by,
  // and the one an activation/rollback supersedes). In-memory over the loaded
  // list — no extra query.
  const currentActive = selectedVersion
    ? (versions.find(
        (v) => v.cardName === selectedVersion.cardName && v.status === "ACTIVE",
      ) ?? null)
    : null;

  // The diff is computed (two full row reads, pm62) in TWO cases, reconciling
  // pm66 D6 with §3.23: (1) the Diff tab renders the panel; (2) a mutable
  // version (DRAFT/SUPERSEDED) needs the added/changed/removed counts for its
  // Activate/Rollback confirmation, which sits in the always-visible version
  // header (D6 — the counts are a load-bearing part of the review, so they must
  // be available whatever tab is open). Inv. #59 forbids caching, so this
  // recomputes per request; the cost is bounded (a single RevOps admin, a card
  // that only occasionally has an open DRAFT). An ACTIVE/other version on a
  // non-diff tab costs no diff read — the common read path keeps pm65's budget.
  const isMutable =
    selectedVersion?.status === "DRAFT" ||
    selectedVersion?.status === "SUPERSEDED";
  const needsDiff =
    selectedVersion !== null && (isMutable || params.tab === "diff");
  const needsRows = selectedVersionId !== null && params.tab === "rows";

  // The diff and the paged rows are independent reads — run them concurrently
  // (the diff feeds the confirmation counts / the Diff tab; the rows feed the
  // Rows tab), so a mutable version on the Rows tab waits max(diff, rows), not
  // their sum. Mirrors the Promise.all the versions + locale reads already use.
  const [diff, rowsPage] = await Promise.all([
    needsDiff && selectedVersion
      ? getRateCardVersionDiff(
          selectedVersion.cardName,
          selectedVersion.ratecardVersionId,
        )
      : Promise.resolve(null),
    needsRows && selectedVersionId
      ? getRateCardVersionRows(selectedVersionId, {
          page: params.page,
          filter: params.q,
        })
      : Promise.resolve(null),
  ]);

  // The confirmation counts. The `{0,0,0}` branch is a cheap safety net only:
  // the Activate/Rollback dialogs render exclusively for DRAFT/SUPERSEDED
  // versions, for which `isMutable` forces `diff` non-null — so the fallback is
  // never what a rendered dialog receives; it just keeps the type total.
  const diffCounts = diff
    ? {
        added: diff.added.count,
        changed: diff.changed.count,
        removed: diff.removed.count,
      }
    : { added: 0, changed: 0, removed: 0 };

  // A checksum match against an earlier version of the same card — the only
  // warning (never blocking, ui-context §10.4). Computed in memory.
  const checksumDuplicate =
    selectedVersion !== null &&
    selectedVersion.fileChecksum !== null &&
    versions.some(
      (v) =>
        v.ratecardVersionId !== selectedVersion.ratecardVersionId &&
        v.cardName === selectedVersion.cardName &&
        v.fileChecksum === selectedVersion.fileChecksum,
    );

  const distinctCardNames = Array.from(
    new Set(versions.map((v) => v.cardName)),
  );

  return (
    <main className="space-y-5 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-foreground">Rate Card</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Every rate-card version the system has. Select a version to preview
            its rows, review the diff, and activate it.
          </p>
        </div>
        {/* "Upload new version" — record-creation, so `--action-primary-bg`,
            NOT the page CTA (the CTA is Activate, D6/C10). EDIT only (D11). */}
        {canEdit && (
          <UploadVersionDialog
            cardNames={distinctCardNames}
            trigger={
              <button
                type="button"
                aria-label="Upload new version"
                className={UPLOAD_BUTTON_CLASS}
              >
                <Upload size={16} aria-hidden />
                Upload new version
              </button>
            }
          />
        )}
      </header>

      <RateCardVersionTable
        versions={versions}
        selectedVersionId={selectedVersionId}
        locale={locale}
        timezone={timezone}
      />

      {selectedVersion ? (
        <section className="space-y-4">
          {/* Selected-version header — metadata strip + the DRAFT/SUPERSEDED
              action (in the selected version's header, never on every row —
              §4.10). ACTIVE shows no mutating action at all (D11). */}
          <div className="flex flex-wrap items-end justify-between gap-4 rounded-md bg-[color:var(--surface-sunken)] p-4">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
              <MetaItem label="Version">
                <span className="font-mono text-mono">
                  {selectedVersion.ratecardVersionId}
                </span>
              </MetaItem>
              <MetaItem label="Card">
                <span className="font-mono text-mono">
                  {selectedVersion.cardName}
                </span>
              </MetaItem>
              <MetaItem label="Status">
                <RateCardStatusBadge status={selectedVersion.status} />
              </MetaItem>
              <MetaItem label="Snapshot date">
                <span className="tabular-nums">
                  {formatCalendarDate(selectedVersion.snapshotDate, "iso")}
                </span>
              </MetaItem>
              <MetaItem label="Rows">
                <span className="tabular-nums">{selectedVersion.rowCount}</span>
              </MetaItem>
              <MetaItem label="Checksum">
                <span className="font-mono text-mono">
                  {truncateChecksum(selectedVersion.fileChecksum)}
                </span>
              </MetaItem>
            </dl>

            {canEdit && selectedVersion.status === "DRAFT" && (
              <ActivateVersionDialog
                versionId={selectedVersion.ratecardVersionId}
                versionNum={selectedVersion.versionNum}
                supersededVersionId={currentActive?.ratecardVersionId ?? null}
                counts={diffCounts}
                trigger={
                  <button
                    type="button"
                    aria-label="Activate version"
                    className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
                  >
                    <CheckCircle size={16} aria-hidden />
                    Activate version
                  </button>
                }
              />
            )}
            {canEdit && selectedVersion.status === "SUPERSEDED" && (
              <RollbackVersionDialog
                versionId={selectedVersion.ratecardVersionId}
                versionNum={selectedVersion.versionNum}
                demotedVersionId={currentActive?.ratecardVersionId ?? null}
                counts={diffCounts}
                trigger={
                  <button
                    type="button"
                    aria-label="Roll back to this version"
                    className={VERSION_ACTION_CLASS}
                  >
                    <History size={16} aria-hidden />
                    Roll back to this version
                  </button>
                }
              />
            )}
          </div>

          {/* Tabs — three views of one version (ui-context §10.5). URL-driven
              `<Link>`s. `tab` gates the diff read (C3/§3.23): a plain ACTIVE
              version pays for the diff only on `?tab=diff`. A DRAFT/SUPERSEDED
              version additionally computes it for the confirmation counts (D6,
              see the diff-read note above), so for those the diff is not
              tab-gated. */}
          <div className="flex items-center gap-1 border-b border-border">
            {TABS.map((t) => {
              const active = params.tab === t.key;
              return (
                <Link
                  key={t.key}
                  href={buildRateCardHref({
                    version: selectedVersionId,
                    tab: t.key,
                    // Preserve the rows filter/page across a tab round-trip
                    // (they are inert on the diff/validation tabs and restore
                    // the rows position on return). buildRateCardHref drops
                    // both when they are at their defaults.
                    q: params.q,
                    page: params.page,
                  })}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "border-b-2 border-[color:var(--color-primary-500)] px-3 py-2 text-body-sm font-semibold text-[color:var(--text-link)]"
                      : "border-b-2 border-transparent px-3 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground"
                  }
                >
                  {t.label}
                </Link>
              );
            })}
          </div>

          {params.tab === "diff" && diff ? (
            <RateCardDiffPanel
              diff={diff}
              currentActiveVersionId={currentActive?.ratecardVersionId ?? null}
            />
          ) : params.tab === "validation" ? (
            <div className="space-y-3">
              {checksumDuplicate && (
                <p className="rounded-md bg-[color:var(--bg-info)] p-3 text-body-sm text-[color:var(--text-info)]">
                  This file&apos;s checksum matches an earlier version of the
                  card — a possible duplicate upload. This is a warning only and
                  never blocks activation.
                </p>
              )}
              <p className="rounded-md bg-[color:var(--surface-sunken)] p-6 text-center text-body text-muted-foreground">
                This version passed structural validation — a version only
                exists because its upload was accepted.
              </p>
            </div>
          ) : rowsPage ? (
            <RateCardRowPreview
              key={selectedVersionId}
              versionId={selectedVersion.ratecardVersionId}
              rows={rowsPage.rows}
              total={rowsPage.total}
              page={rowsPage.page}
              pageSize={rowsPage.pageSize}
              query={params.q}
            />
          ) : null}
        </section>
      ) : (
        <div className="rounded-md bg-[color:var(--surface-sunken)] p-8 text-center text-body text-muted-foreground">
          {versionNotFound
            ? "That version was not found. Pick a version from the list above."
            : "Select a version to preview its rows."}
        </div>
      )}
    </main>
  );
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-overline tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-body font-medium text-foreground">{children}</dd>
    </div>
  );
}
