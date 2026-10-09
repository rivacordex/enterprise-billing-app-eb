// bm55-spec §Design D4 (`generated` tab), ui-context §9/§8 — `GeneratedHbsViewer`.
// A SERVER component: the shown version's stored `invoice.hbs` and
// `footer.hbs` as read-only mono `<pre>` blocks with CSS-counter line numbers
// (`--radius-sm` on `--surface-sunken`). The text arrives as verified bytes
// (`loadGeneratedFiles`) and renders as React text — escaped, never as markup.
// The download links hit the session-guarded GET handler, which serves the
// same stored bytes.

import { Download } from "lucide-react";

import { INVOICE_TEMPLATE_FILES_BASE } from "@/components/billing/invoice-settings/version-history-table";

export interface GeneratedHbsViewerProps {
  versionId: string;
  versionNo: number;
  invoiceHbs: string;
  footerHbs: string;
}

const DOWNLOADS = ["invoice.hbs", "footer.hbs", "structure.json"] as const;

function SourceBlock({
  title,
  source,
}: {
  title: string;
  source: string;
}): React.JSX.Element {
  const lines = source.replace(/\n$/, "").split("\n");
  return (
    <section className="space-y-2">
      <h3 className="font-mono text-mono font-semibold text-foreground">
        {title}
      </h3>
      <pre
        aria-label={title}
        className="max-h-[32rem] overflow-auto rounded-sm bg-[color:var(--surface-sunken)] py-3 font-mono text-body-sm text-foreground [counter-reset:line]"
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className="block pr-4 [counter-increment:line] before:mr-4 before:inline-block before:w-10 before:pr-2 before:text-right before:text-[color:var(--text-muted)] before:content-[counter(line)] before:select-none"
          >
            {line === "" ? " " : line}
          </span>
        ))}
      </pre>
    </section>
  );
}

export function GeneratedHbsViewer({
  versionId,
  versionNo,
  invoiceHbs,
  footerHbs,
}: GeneratedHbsViewerProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-body-sm text-muted-foreground">
          Generated files for template{" "}
          <span className="font-mono text-mono">v{versionNo}</span> — read-only,
          exactly as stored.
        </p>
        <div className="ml-auto flex flex-wrap gap-3">
          {DOWNLOADS.map((file) => (
            <a
              key={file}
              href={`${INVOICE_TEMPLATE_FILES_BASE}/${versionId}/files/${file}`}
              download
              className="inline-flex items-center gap-1 text-body-sm font-medium text-[color:var(--action-primary-bg)] hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
            >
              <Download size={14} aria-hidden />
              Download {file}
            </a>
          ))}
        </div>
      </div>
      <SourceBlock title="invoice.hbs" source={invoiceHbs} />
      <SourceBlock title="footer.hbs" source={footerHbs} />
    </div>
  );
}
