"use client";

// bm55-spec §Design D4, code-standards Part 2 Next.js rule 5, ui-context
// §10b/§6c — `InvoicePreviewFrame`. The preview HTML is shown ONLY inside
// `<iframe sandbox="" srcDoc>`: an empty `sandbox` grants nothing (no scripts,
// no same-origin, no forms), and the HTML never touches the app DOM (no
// `dangerouslySetInnerHTML`). A4-proportioned and square (`--radius-none` —
// it is a sheet of paper). Loading/queued/error reuse the §6c PDF skeleton
// and captions; a `PREVIEW_FAILED` shows its code in a Danger alert.

import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type PreviewStatus = "loading" | "queued" | "ready" | "error";

export interface PreviewError {
  code: string;
  detail?: string | undefined;
}

export interface InvoicePreviewFrameProps {
  html: string | null;
  status: PreviewStatus;
  error: PreviewError | null;
  onRetry: () => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  PREVIEW_FAILED: "The preview could not be rendered.",
  RATE_LIMITED: "Too many preview requests — wait a moment, then retry.",
  NOT_FOUND: "That bill no longer exists.",
  FORBIDDEN: "You do not have permission to preview this source.",
  VALIDATION_ERROR: "The structure is not valid.",
};

function Skeleton({ queued }: { queued: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <div className="pdfwrap w-2/3 max-w-xs animate-pulse space-y-2 rounded-sm bg-[color:var(--surface-card)] p-4 shadow-sm">
        <div className="h-3 w-1/2 rounded bg-[color:var(--color-neutral-200)]" />
        <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
        <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
        <div className="h-2 w-5/6 rounded bg-[color:var(--color-neutral-100)]" />
        <div className="mt-4 h-2 w-1/3 rounded bg-[color:var(--color-neutral-100)]" />
      </div>
      <p className="text-body-sm text-muted-foreground">
        {queued ? "Queued — rendering shortly" : "Rendering draft invoice…"}
      </p>
    </div>
  );
}

export function InvoicePreviewFrame({
  html,
  status,
  error,
  onRetry,
}: InvoicePreviewFrameProps): React.JSX.Element {
  const busy = status === "loading" || status === "queued";
  return (
    <div className="space-y-3">
      {status === "error" && error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>
            {ERROR_MESSAGES[error.code] ?? "The preview failed."}
          </AlertTitle>
          <AlertDescription>
            {error.detail ? (
              <span className="font-mono text-mono">{error.detail}</span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-fit"
              onClick={onRetry}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        aria-busy={busy}
        className="relative aspect-[210/297] w-full overflow-hidden rounded-none border border-[color:var(--border-default)] bg-[color:var(--surface-sunken)]"
      >
        {html === null ? (
          busy ? (
            <Skeleton queued={status === "queued"} />
          ) : null
        ) : (
          <>
            <iframe
              sandbox=""
              srcDoc={html}
              title="Invoice preview"
              className="h-full w-full border-0 bg-white"
            />
            {busy ? (
              <p className="absolute top-2 right-2 rounded-sm bg-[color:var(--surface-card)] px-2 py-1 text-caption text-muted-foreground shadow-sm">
                {status === "queued"
                  ? "Queued — rendering shortly"
                  : "Rendering draft invoice…"}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
