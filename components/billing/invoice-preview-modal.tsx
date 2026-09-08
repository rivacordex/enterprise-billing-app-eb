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
import { Download, FileCheck, FileText } from "lucide-react";

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
  // The in-flight render's controller. It's the single source of truth for
  // "which render is current": close, unmount, and Retry all abort through it,
  // and a settling request that no longer holds it treats itself as stale.
  const controllerRef = useRef<AbortController | null>(null);

  function revokeObjectUrl(): void {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  function abortActiveRender(): void {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  // The actual fetch — assumes the caller has already reset state to
  // "loading" (react-hooks/set-state-in-effect: an async function whose
  // synchronous prefix calls setState is treated the same as calling setState
  // directly in an effect body, so that reset lives in `startRender` below,
  // never here).
  async function runRender(): Promise<void> {
    // Supersede any in-flight render (Retry, or a rapid close/reopen) so its
    // late completion can't overwrite this generation's state or leak an
    // object URL.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // Stale once this render no longer owns the ref: superseded above, or
    // cleared by close/unmount. A timeout abort (below) leaves the ref intact,
    // so it is NOT stale and still surfaces the error state.
    const isStale = (): boolean => controllerRef.current !== controller;

    const queuedTimer = setTimeout(() => {
      setState((current) => (current === "loading" ? "queued" : current));
    }, QUEUED_HINT_DELAY_MS);
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RENDER_TIMEOUT_MS);

    try {
      const response = await fetch(
        `/billing/bill-runs/${billRunId}/draft-invoice/${billingAccountId}`,
        { signal: controller.signal },
      );
      if (isStale()) return;
      if (!response.ok) {
        setErrorMessage(describeRenderError(response.status));
        setState("error");
        return;
      }
      const blob = await response.blob();
      if (isStale()) return;
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPdfUrl(url);
      setState("ready");
    } catch {
      // A superseded/closed/unmounted render aborts expectedly — it no longer
      // owns the UI, so surface nothing. Otherwise distinguish the
      // RENDER_TIMEOUT abort (ref still intact, `timedOut` set) from a genuine
      // network failure so the message matches the actual cause.
      if (isStale()) return;
      setErrorMessage(
        timedOut
          ? "The draft invoice took too long to render. Please try again."
          : "Could not render the draft invoice. Please try again.",
      );
      setState("error");
    } finally {
      clearTimeout(queuedTimer);
      clearTimeout(timeoutTimer);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
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
      abortActiveRender();
      revokeObjectUrl();
      setPdfUrl(null);
    }
    // Re-run only when the modal opens/closes — startRender is intentionally
    // re-created each render (it closes over fresh state setters) and would
    // otherwise re-trigger this effect on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      abortActiveRender();
      revokeObjectUrl();
    };
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
            On-demand preview, never stored. Rendered fresh every time you open
            it.
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
    case 401:
      return "Your session has expired. Please refresh the page and sign in again.";
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

// bm19-spec §Implementation §5 — `StoredInvoiceModal`, the posted-invoice
// counterpart to `InvoicePreviewModal`: no watermark or preview-only banner
// (this IS the issued record), shows the real `INV…` number and the stored
// artifact's `blob_ref`/`checksum` (Design "Two checksums, two purposes" —
// this is the PDF-bytes checksum, not the charge checksum), and a Download
// button. Fetches the session-guarded stored-invoice route the same way
// `InvoicePreviewModal` fetches the draft route (D-T2's rationale — client-
// driven loading/error states, never a bare `<iframe src>`); reads the
// artifact identity from that same response's headers rather than a second
// round-trip. Built on the shared `Dialog`, which already provides the
// D-T5 a11y contract (focus trap, Esc-to-close, focus return) — the only
// addition here is the accessible `<iframe title>` carrying the real `INV…`
// reference (ui-context §6c).
export interface StoredInvoiceModalProps {
  billRunId: string;
  billingAccountId: string;
  accountName: string;
}

type StoredInvoiceState = "loading" | "ready" | "error";

// The stored artifact is served (not re-rendered), so this is a plain blob
// download — but a hung download must still never leave a frozen frame
// indefinitely (D-T2), so it is bounded the same way the draft render is.
const STORED_FETCH_TIMEOUT_MS = 25_000;

export function StoredInvoiceModal({
  billRunId,
  billingAccountId,
  accountName,
}: StoredInvoiceModalProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StoredInvoiceState>("loading");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null);
  const [blobRef, setBlobRef] = useState<string | null>(null);
  const [checksum, setChecksum] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Mirrors InvoicePreviewModal: the in-flight fetch's controller is the
  // single source of truth for "which fetch is current" — close, unmount, and
  // Retry all abort through it, and a settling request that no longer holds it
  // treats itself as stale.
  const controllerRef = useRef<AbortController | null>(null);

  function revokeObjectUrl(): void {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  function abortActiveRender(): void {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  async function runFetch(): Promise<void> {
    // Supersede any in-flight fetch (Retry, or a rapid close/reopen) so its
    // late completion can't overwrite this generation's state or leak an
    // object URL.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // Stale once this fetch no longer owns the ref: superseded above, or
    // cleared by close/unmount. A timeout abort (below) leaves the ref intact,
    // so it is NOT stale and still surfaces the error/retry state.
    const isStale = (): boolean => controllerRef.current !== controller;
    const timeoutTimer = setTimeout(
      () => controller.abort(),
      STORED_FETCH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `/billing/bill-runs/${billRunId}/stored-invoice/${billingAccountId}`,
        { signal: controller.signal },
      );
      if (isStale()) return;
      if (!response.ok) {
        setErrorMessage(describeStoredInvoiceError(response.status));
        setState("error");
        return;
      }
      const blob = await response.blob();
      if (isStale()) return;
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPdfUrl(url);
      setInvoiceNumber(response.headers.get("X-Invoice-Number"));
      setBlobRef(response.headers.get("X-Blob-Ref"));
      setChecksum(response.headers.get("X-Checksum"));
      setState("ready");
    } catch {
      // A superseded/closed/unmounted fetch aborts expectedly — it no longer
      // owns the UI, so surface nothing. A genuine network failure or the
      // timeout abort (ref still intact) falls through to the error/retry.
      if (isStale()) return;
      setErrorMessage(
        "Could not retrieve the stored invoice. Please try again.",
      );
      setState("error");
    } finally {
      clearTimeout(timeoutTimer);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }

  function startFetch(): void {
    setState("loading");
    setErrorMessage(null);
    void runFetch();
  }

  useEffect(() => {
    if (open) {
      // See the same react-hooks/set-state-in-effect note on
      // `InvoicePreviewModal` above — opening the modal is the external
      // system (the session-guarded stored-invoice route) this effect
      // synchronizes with.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startFetch();
    } else {
      abortActiveRender();
      revokeObjectUrl();
      setPdfUrl(null);
      // Reset the display to its initial state so a reopen starts in "loading"
      // with no stale ready frame or header — the invoice number is shown in
      // the description (and blob/checksum in the ready panel) before the next
      // fetch resolves, so leaving them set flashes the previous invoice.
      setState("loading");
      setInvoiceNumber(null);
      setBlobRef(null);
      setChecksum(null);
      setErrorMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      abortActiveRender();
      revokeObjectUrl();
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <FileCheck aria-hidden="true" />⬇ Stored invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Stored invoice — {accountName}</DialogTitle>
          <DialogDescription>
            {invoiceNumber ?? "…"} — the immutable, issued record. Retrieved
            from the stored artifact, never re-rendered.
          </DialogDescription>
        </DialogHeader>

        {state === "ready" && (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-caption text-muted-foreground sm:grid-cols-2">
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="font-medium text-foreground">Blob ref</dt>
              <dd className="truncate font-mono text-mono">{blobRef}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="font-medium text-foreground">Checksum</dt>
              <dd className="truncate font-mono text-mono">{checksum}</dd>
            </div>
          </dl>
        )}

        <div className="h-[70vh] w-full overflow-hidden rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-sunken)]">
          {state === "loading" && (
            <div
              role="status"
              aria-live="polite"
              className="flex h-full flex-col items-center justify-center gap-3 p-6"
            >
              <div className="w-2/3 max-w-xs animate-pulse space-y-2 rounded-sm bg-[color:var(--surface-card)] p-4 shadow-sm">
                <div className="h-3 w-1/2 rounded bg-[color:var(--color-neutral-200)]" />
                <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
                <div className="h-2 w-full rounded bg-[color:var(--color-neutral-100)]" />
              </div>
              <p className="text-body-sm text-muted-foreground">
                Retrieving stored invoice…
              </p>
            </div>
          )}

          {state === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-sm text-body-sm text-destructive">
                {errorMessage}
              </p>
              <Button type="button" variant="outline" onClick={startFetch}>
                Retry
              </Button>
            </div>
          )}

          {state === "ready" && pdfUrl && (
            <iframe
              src={pdfUrl}
              title={`Invoice ${invoiceNumber ?? billingAccountId}`}
              className="h-full w-full border-0"
            />
          )}
        </div>

        {state === "ready" && pdfUrl && (
          <Button asChild variant="default">
            <a
              href={pdfUrl}
              download={`${invoiceNumber ?? billingAccountId}.pdf`}
            >
              <Download aria-hidden="true" />
              Download
            </a>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function describeStoredInvoiceError(status: number): string {
  switch (status) {
    case 401:
      return "Your session has expired. Please refresh the page and sign in again.";
    case 403:
      return "You do not have permission to view this invoice.";
    case 404:
      return "No stored invoice found for this account yet.";
    default:
      return "Could not retrieve the stored invoice. Please try again.";
  }
}
