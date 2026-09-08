"use client";

// bm18-spec §Implementation §4 — `InvoicePreviewModal`. Opens the account's
// session-guarded draft-invoice route via `fetch` (not a bare `<iframe src>`)
// so the client can drive its own loading/queued/error states (Phase-2
// review fold D-T2) instead of showing a frozen/empty frame while Chromium
// renders. `Dialog` (Radix) already provides the D-T5 a11y contract — focus
// trap, Esc-to-close, and focus return to the trigger — for free; the only
// addition here is the accessible `<iframe title>`.
//
// Low-emphasis trigger (quiet ghost, never the featured petrol or a danger
// role, ui-context §7) — reachable from the Customers & Bills tab per the
// mockup's "Preview PRO-FORMA →".

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface InvoicePreviewModalProps {
  billRunId: string;
  billingAccountId: string;
  accountName: string;
}

type RenderState = "loading" | "queued" | "ready" | "error";

// A normal (unqueued) render is 1-3s (spec §Phase-2 review folds D-T2); past
// this the request is most likely sitting behind the render-side concurrency
// guard (render-invoice.ts), so the caption switches to reflect that.
const QUEUED_HINT_DELAY_MS = 2_500;
// A render that hasn't resolved by here is treated as failed/stuck — the
// modal must never show a frozen/empty frame indefinitely (D-T2).
const RENDER_TIMEOUT_MS = 25_000;

export function InvoicePreviewModal({
  billRunId,
  billingAccountId,
  accountName,
}: InvoicePreviewModalProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RenderState>("loading");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  function revokeObjectUrl(): void {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  // The actual fetch — assumes the caller has already reset state to
  // "loading" (react-hooks/set-state-in-effect: an async function whose
  // synchronous prefix calls setState is treated the same as calling setState
  // directly in an effect body, so that reset lives in `startRender` below,
  // never here).
  async function runRender(): Promise<void> {
    const queuedTimer = setTimeout(() => {
      setState((current) => (current === "loading" ? "queued" : current));
    }, QUEUED_HINT_DELAY_MS);
    const controller = new AbortController();
    const timeoutTimer = setTimeout(
      () => controller.abort(),
      RENDER_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `/billing/bill-runs/${billRunId}/draft-invoice/${billingAccountId}`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        setErrorMessage(describeRenderError(response.status));
        setState("error");
        return;
      }
      const blob = await response.blob();
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPdfUrl(url);
      setState("ready");
    } catch {
      setErrorMessage(
        "The draft invoice took too long to render. Please try again.",
      );
      setState("error");
    } finally {
      clearTimeout(queuedTimer);
      clearTimeout(timeoutTimer);
    }
  }

  // Shared by the open-effect below and the Retry button: reset to "loading"
  // then kick off the fetch.
  function startRender(): void {
    setState("loading");
    setErrorMessage(null);
    void runRender();
  }

  useEffect(() => {
    if (open) {
      // react-hooks/set-state-in-effect flags this as a synchronous setState
      // in an effect — deliberate here: opening the modal is exactly the
      // "external system" (the session-guarded PDF route) this effect
      // synchronizes with, and the immediate "loading" state is what drives
      // the D-T2 requirement that the skeleton appears the instant the modal
      // opens, never a blank frame.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startRender();
    } else {
      revokeObjectUrl();
      setPdfUrl(null);
    }
    // Re-run only when the modal opens/closes — startRender is intentionally
    // re-created each render (it closes over fresh state setters) and would
    // otherwise re-trigger this effect on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => revokeObjectUrl();
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <FileText aria-hidden="true" />
          Preview PRO-FORMA →
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Draft invoice preview — {accountName}</DialogTitle>
          <DialogDescription>
            On-demand preview, never stored. Rendered fresh every time you
            open it.
          </DialogDescription>
        </DialogHeader>

        <div
          role="note"
          className="rounded-sm border border-[color:var(--color-warning-500)] bg-[color:var(--color-warning-50)] px-3 py-2 text-body-sm font-medium text-[color:var(--color-warning-700)]"
        >
          Draft / PRO-FORMA — not a valid invoice.
        </div>

        <div className="h-[70vh] w-full overflow-hidden rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-sunken)]">
          {(state === "loading" || state === "queued") && (
            <div
              role="status"
              aria-live="polite"
              className="flex h-full flex-col items-center justify-center gap-3 p-6"
            >
              <div className="pdfwrap w-2/3 max-w-xs animate-pulse space-y-2 rounded-sm bg-[color:var(--surface-card)] p-4 shadow-sm">
                <div className="h-3 w-1/2 rounded bg-[color:var(--color-neutral-200)]" />
                <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
                <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
                <div className="h-2 w-5/6 rounded bg-[color:var(--color-neutral-100)]" />
                <div className="mt-4 h-2 w-1/3 rounded bg-[color:var(--color-neutral-100)]" />
              </div>
              <p className="text-body-sm text-muted-foreground">
                {state === "queued"
                  ? "Queued — rendering shortly"
                  : "Rendering draft invoice…"}
              </p>
            </div>
          )}

          {state === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-sm text-body-sm text-destructive">
                {errorMessage}
              </p>
              <Button type="button" variant="outline" onClick={startRender}>
                Retry
              </Button>
            </div>
          )}

          {state === "ready" && pdfUrl && (
            <iframe
              src={pdfUrl}
              title={`Draft PRO-FORMA invoice — ${billingAccountId}`}
              className="h-full w-full border-0"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function describeRenderError(status: number): string {
  switch (status) {
    case 429:
      return "Too many preview requests right now — please wait a moment and try again.";
    case 403:
      return "You do not have permission to preview this invoice.";
    case 404:
      return "No draft bill found for this account yet.";
    default:
      return "Could not render the draft invoice. Please try again.";
  }
}
