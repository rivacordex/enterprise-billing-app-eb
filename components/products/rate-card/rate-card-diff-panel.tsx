import { RateCardDiffBadge } from "@/components/products/rate-card/rate-card-diff-badge";
import { cn } from "@/lib/utils";
import type {
  RateCardDiffChangedEntry,
  RateCardVersionDiff,
  RatecardRanUsageLkp,
} from "@/types/product";

// pm66-spec D5 / ui-context §10.2 — the diff panel. SERVER component (D10):
// renders pm62's three buckets in CONTRACT ORDER (added, changed, removed),
// each section headed by its count (§4.25). Reuses the Administration table
// shape (§4.3), no parallel table. It renders `{ added, changed, removed }` and
// nothing else — no client mirror of any server rule (D10).
//
// "Removed" takes danger and the copy carries the nuance so danger never reads
// as _deleted_ (D5): the qualifier "Not in this upload; still held by
// RCV########" sits in `--text-muted` with the superseded version id in
// `--font-mono`. Never "Retiring", never "carried forward" — nothing is copied
// into the new version (D-A7).

// The non-key columns compared as payload (§6.29 / diff-versions.ts's own
// `payloadDiffers`), with a display label each. Order is stable so a changed
// row lists its differing fields the same way every time.
const COMPARED_FIELDS: ReadonlyArray<{
  key: keyof RatecardRanUsageLkp;
  label: string;
}> = [
  { key: "lkpSubscriberRefId", label: "Subscriber Ref" },
  { key: "serviceCode", label: "Service Code" },
  { key: "polygonStartDate", label: "Polygon start" },
  { key: "polygonEndDate", label: "Polygon end" },
  { key: "state", label: "State" },
  { key: "district", label: "District" },
  { key: "ratePerUnit", label: "Rate / unit" },
];

// Cap the RENDERED rows per bucket so 5,400 rows never render at once
// (ui-context §10.7). The bucket COUNT in the header is always the true total;
// when a bucket exceeds the cap, a "+N more" line makes the truncation
// explicit — never a silent cap.
const MAX_ROWS_PER_BUCKET = 50;

export interface RateCardDiffPanelProps {
  diff: RateCardVersionDiff;
  // The card's current ACTIVE version — the one that still holds every "removed"
  // key after this version goes live (null when the card has no ACTIVE version,
  // in which case every incoming key is "added" and the removed bucket is
  // empty).
  currentActiveVersionId: string | null;
}

function KeyCell({
  row,
}: {
  row: Pick<
    RatecardRanUsageLkp,
    "mnoPublicKey" | "commercialUnitPublicKey" | "polygonId"
  >;
}): React.JSX.Element {
  return (
    <span className="font-mono text-mono">
      {row.mnoPublicKey} · {row.commercialUnitPublicKey} · {row.polygonId}
    </span>
  );
}

function fmt(value: string | null): string {
  return value === null || value === "" ? "—" : value;
}

function ChangedFields({
  entry,
}: {
  entry: RateCardDiffChangedEntry;
}): React.JSX.Element {
  const differing = COMPARED_FIELDS.filter(
    (f) => entry.outgoing[f.key] !== entry.incoming[f.key],
  );
  return (
    <ul className="flex flex-col gap-0.5">
      {differing.map((f) => (
        <li key={f.key} className="text-body-sm">
          <span className="text-[color:var(--text-muted)]">{f.label}: </span>
          {/* old — muted, line-through; new — primary, weight 500; both mono.
              No red/green cell fill (the row badge carries the colour, D5). */}
          <span className="font-mono text-[color:var(--text-muted)] line-through">
            {fmt(entry.outgoing[f.key] as string | null)}
          </span>
          <span aria-hidden> → </span>
          <span className="font-mono font-medium text-foreground">
            {fmt(entry.incoming[f.key] as string | null)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BucketHeader({
  category,
  count,
}: {
  category: "added" | "changed" | "removed";
  count: number;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-[color:var(--surface-sunken)] px-4 py-2">
      <RateCardDiffBadge category={category} />
      <span className="text-body-sm font-semibold text-foreground tabular-nums">
        {count}
      </span>
    </div>
  );
}

function MoreRow({ hidden }: { hidden: number }): React.JSX.Element | null {
  if (hidden <= 0) return null;
  return (
    <li className="px-4 py-2 text-caption text-[color:var(--text-muted)]">
      +{hidden} more not shown — refine the version or review the full export.
    </li>
  );
}

export function RateCardDiffPanel({
  diff,
  currentActiveVersionId,
}: RateCardDiffPanelProps): React.JSX.Element {
  const { added, changed, removed } = diff;

  const noChanges =
    added.count === 0 && changed.count === 0 && removed.count === 0;

  return (
    <div className="flex flex-col gap-4">
      {noChanges && (
        <p className="rounded-md bg-[color:var(--surface-sunken)] p-6 text-center text-body text-muted-foreground">
          No differences against the current active version.
        </p>
      )}

      {/* Added */}
      <section className="rounded-md bg-card shadow-sm">
        <BucketHeader category="added" count={added.count} />
        {added.count > 0 && (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {added.rows.slice(0, MAX_ROWS_PER_BUCKET).map((entry) => (
              <li
                key={`${entry.mnoPublicKey}-${entry.commercialUnitPublicKey}-${entry.polygonId}`}
                className="px-4 py-2"
              >
                <KeyCell row={entry} />
              </li>
            ))}
            <MoreRow hidden={added.count - MAX_ROWS_PER_BUCKET} />
          </ul>
        )}
      </section>

      {/* Changed */}
      <section className="rounded-md bg-card shadow-sm">
        <BucketHeader category="changed" count={changed.count} />
        {changed.count > 0 && (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {changed.rows.slice(0, MAX_ROWS_PER_BUCKET).map((entry) => (
              <li
                key={`${entry.mnoPublicKey}-${entry.commercialUnitPublicKey}-${entry.polygonId}`}
                className="flex flex-col gap-1 px-4 py-2"
              >
                <KeyCell row={entry} />
                <ChangedFields entry={entry} />
              </li>
            ))}
            <MoreRow hidden={changed.count - MAX_ROWS_PER_BUCKET} />
          </ul>
        )}
      </section>

      {/* Removed */}
      <section className="rounded-md bg-card shadow-sm">
        <BucketHeader category="removed" count={removed.count} />
        {removed.count > 0 && (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {removed.rows.slice(0, MAX_ROWS_PER_BUCKET).map((entry) => (
              <li
                key={`${entry.mnoPublicKey}-${entry.commercialUnitPublicKey}-${entry.polygonId}`}
                className={cn("flex flex-col gap-0.5 px-4 py-2")}
              >
                <KeyCell row={entry} />
                {/* Danger never reads as "deleted" — the row stays readable in
                    the version being superseded (D-A7). */}
                <span className="text-caption text-[color:var(--text-muted)]">
                  Not in this upload
                  {currentActiveVersionId !== null ? (
                    <>
                      {"; still held by "}
                      <span className="font-mono text-mono">
                        {currentActiveVersionId}
                      </span>
                    </>
                  ) : null}
                  .
                </span>
              </li>
            ))}
            <MoreRow hidden={removed.count - MAX_ROWS_PER_BUCKET} />
          </ul>
        )}
      </section>
    </div>
  );
}
