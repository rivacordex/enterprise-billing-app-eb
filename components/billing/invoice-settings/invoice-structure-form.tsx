"use client";

// bm55-spec §Design D4 (`edit` tab), code-standards Part 2 Next.js rules 5/6,
// Styling rule 7, ui-context §10b — `InvoiceStructureForm`, the template
// editor's interaction leaf. It holds the admin's UNSAVED structure and drives
// the live preview: any change → a 400 ms debounced call to
// `previewInvoiceTemplateAction` (a READ that saves nothing). bm55 has no Save
// or Activate (bm57/bm58).
//
//   - mandatory sections: checked + disabled + `Lock` + "Required" in
//     `--text-muted`; the label stays `--text-body`, so a locked-on section
//     never looks switched off;
//   - read-only (a READ user, or a non-current version opened from history):
//     sections/columns render as text "Shown"/"Hidden" with no grey wash —
//     the placeholder/outline toggles and the source select still drive the
//     preview;
//   - the source select offers the layout's sample bill and, only for a
//     `billrun_view` holder, the most recent posted bills.

import { useEffect, useRef, useState } from "react";
import { Info, Lock } from "lucide-react";

import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import {
  InvoicePreviewFrame,
  type PreviewError,
  type PreviewStatus,
} from "@/components/billing/invoice-settings/invoice-preview-frame";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  INVOICE_COLUMN_KEYS,
  INVOICE_OPTIONAL_SECTION_KEYS,
  type InvoiceColumnKey,
  type InvoiceSectionKey,
  type InvoiceTemplateStructure,
  type RecentPostedBill,
} from "@/types/billing";

// Display order follows the layout (`INVTPL-STD-A4` manifest order).
const SECTION_ROWS: { key: InvoiceSectionKey; label: string }[] = [
  { key: "identification", label: "Invoice identification" },
  { key: "billTo", label: "Bill-to" },
  { key: "amountDue", label: "Amount due" },
  { key: "chargeSummary", label: "Summary of charges" },
  { key: "taxSummary", label: "Tax summary" },
  { key: "chargeDetails", label: "Charge details" },
  { key: "payment", label: "Payment information" },
  { key: "usageAnnex", label: "Usage annex" },
  { key: "notes", label: "Notes & terms" },
];

const COLUMN_LABELS: Record<InvoiceColumnKey, string> = {
  showServicePeriod: "Service period",
  showDiscountColumn: "Discount",
  showProductId: "Product offering ID",
  showUdrCount: "UDR type & count",
};

const SAMPLE = "sample";
const DEBOUNCE_MS = 400;
// ui-context §6c — past a normal render window the caption reads "Queued".
const QUEUED_HINT_DELAY_MS = 2_500;

function isOptional(key: InvoiceSectionKey): boolean {
  return (INVOICE_OPTIONAL_SECTION_KEYS as readonly string[]).includes(key);
}

interface PreviewState {
  status: PreviewStatus;
  html: string | null;
  templateLabel: string | null;
  pinnedVersionNo: number | null;
  error: PreviewError | null;
}

export interface InvoiceStructureFormProps {
  initialStructure: InvoiceTemplateStructure;
  // false for a READ user or a version opened read-only from history.
  editable: boolean;
  recentBills: RecentPostedBill[];
  canPreviewBills: boolean;
}

function RequiredMark(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-caption text-[color:var(--text-muted)]">
      <Lock size={12} aria-hidden />
      Required
    </span>
  );
}

function ReadOnlyValue({ shown }: { shown: boolean }): React.JSX.Element {
  return (
    <span className="text-body-sm text-foreground">
      {shown ? "Shown" : "Hidden"}
    </span>
  );
}

export function InvoiceStructureForm({
  initialStructure,
  editable,
  recentBills,
  canPreviewBills,
}: InvoiceStructureFormProps): React.JSX.Element {
  const [structure, setStructure] = useState(initialStructure);
  const [source, setSource] = useState<string>(SAMPLE);
  const [annotate, setAnnotate] = useState(false);
  const [outline, setOutline] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({
    status: "loading",
    html: null,
    templateLabel: null,
    pinnedVersionNo: null,
    error: null,
  });
  // The latest request's id — a settling request that no longer holds it is
  // stale and never overwrites newer state.
  const requestRef = useRef(0);

  // Called from event handlers only (react-hooks/set-state-in-effect).
  function markLoading(): void {
    setPreview((p) => ({ ...p, status: "loading", error: null }));
  }

  useEffect(() => {
    const id = ++requestRef.current;
    const debounce = setTimeout(() => {
      const queued = setTimeout(() => {
        if (requestRef.current !== id) return;
        setPreview((p) =>
          p.status === "loading" ? { ...p, status: "queued" } : p,
        );
      }, QUEUED_HINT_DELAY_MS);

      previewInvoiceTemplateAction({
        structure,
        source: source === SAMPLE ? "sample" : { billId: source },
        annotate,
        outline,
      })
        .then((result) => {
          if (requestRef.current !== id) return;
          if (result.ok) {
            setPreview({
              status: "ready",
              html: result.html,
              templateLabel: result.templateLabel,
              pinnedVersionNo: result.pinnedVersionNo,
              error: null,
            });
          } else {
            setPreview((p) => ({
              ...p,
              status: "error",
              error: { code: result.code, detail: result.detail },
            }));
          }
        })
        .catch(() => {
          if (requestRef.current !== id) return;
          setPreview((p) => ({
            ...p,
            status: "error",
            error: { code: "PREVIEW_FAILED" },
          }));
        })
        .finally(() => clearTimeout(queued));
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounce);
  }, [structure, source, annotate, outline, retryToken]);

  function toggleSection(key: InvoiceSectionKey, value: boolean): void {
    markLoading();
    setStructure((s) => ({ ...s, sections: { ...s.sections, [key]: value } }));
  }

  function toggleColumn(key: InvoiceColumnKey, value: boolean): void {
    markLoading();
    setStructure((s) => ({ ...s, columns: { ...s.columns, [key]: value } }));
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-6">
        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Sections
          </legend>
          {SECTION_ROWS.map(({ key, label }) => {
            const optional = isOptional(key);
            const id = `section-${key}`;
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3"
                data-testid={id}
              >
                {editable ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={structure.sections[key]}
                      disabled={!optional}
                      onCheckedChange={(v) => toggleSection(key, v === true)}
                    />
                    <Label
                      htmlFor={id}
                      className="text-body-sm text-foreground"
                    >
                      {label}
                    </Label>
                  </div>
                ) : (
                  <span className="text-body-sm text-foreground">{label}</span>
                )}
                {!optional ? (
                  <span className="flex items-center gap-3">
                    {editable ? null : <ReadOnlyValue shown />}
                    <RequiredMark />
                  </span>
                ) : editable ? null : (
                  <ReadOnlyValue shown={structure.sections[key]} />
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Charge-detail columns
          </legend>
          <p className="text-caption text-muted-foreground">
            Always shown: #, Description, Quantity, Unit price, Gross, Net
            amount.
          </p>
          {INVOICE_COLUMN_KEYS.map((key) => {
            const id = `column-${key}`;
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3"
                data-testid={id}
              >
                {editable ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={structure.columns[key]}
                      onCheckedChange={(v) => toggleColumn(key, v === true)}
                    />
                    <Label
                      htmlFor={id}
                      className="text-body-sm text-foreground"
                    >
                      {COLUMN_LABELS[key]}
                    </Label>
                  </div>
                ) : (
                  <>
                    <span className="text-body-sm text-foreground">
                      {COLUMN_LABELS[key]}
                    </span>
                    <ReadOnlyValue shown={structure.columns[key]} />
                  </>
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Preview
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="preview-source" className="text-body-sm">
              Preview with
            </Label>
            <Select
              value={source}
              onValueChange={(value) => {
                markLoading();
                setSource(value);
              }}
            >
              <SelectTrigger id="preview-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAMPLE}>Sample bill</SelectItem>
                {canPreviewBills
                  ? recentBills.map((bill) => (
                      <SelectItem
                        key={bill.customerBillId}
                        value={bill.customerBillId}
                      >
                        <span className="font-mono text-mono">
                          {bill.invoiceNumber}
                        </span>{" "}
                        · {bill.accountName}
                      </SelectItem>
                    ))
                  : null}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="preview-annotate" className="text-body-sm">
              Show placeholders
            </Label>
            <Switch
              id="preview-annotate"
              checked={annotate}
              onCheckedChange={(v) => {
                markLoading();
                setAnnotate(v);
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="preview-outline" className="text-body-sm">
              Outline
            </Label>
            <Switch
              id="preview-outline"
              checked={outline}
              onCheckedChange={(v) => {
                markLoading();
                setOutline(v);
              }}
            />
          </div>
        </fieldset>
      </div>

      <div className="min-w-0 space-y-3">
        {preview.pinnedVersionNo !== null ? (
          <p
            role="status"
            className="inline-flex items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
          >
            <Info size={14} aria-hidden />
            Showing as issued under template v{preview.pinnedVersionNo}
          </p>
        ) : null}
        {preview.templateLabel ? (
          <p className="text-caption text-muted-foreground">
            {preview.templateLabel}
          </p>
        ) : null}
        <InvoicePreviewFrame
          html={preview.html}
          status={preview.status}
          error={preview.error}
          onRetry={() => {
            markLoading();
            setRetryToken((t) => t + 1);
          }}
        />
      </div>
    </div>
  );
}
