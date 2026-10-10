"use client";

// bm60-spec §Design D7/D8, ui-context §10b ("Logo dropzone") — the invoice
// logo field on the company profile's edit form. A dropzone on
// `--surface-sunken` with a dashed `--border-strong` border and the focus
// ring, plus a keyboard-operable "Choose file" button. The client pre-check
// (size, type) is fast feedback only; the server decides. The preview is the
// STORED version, served by the session-guarded GET route — never a `blob:`
// URL of unvalidated bytes. Enabled only for EDIT users with a working draft.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  importAppLogoAction,
  uploadLogoAction,
  type UploadLogoActionResult,
} from "@/actions/billing/invoice-settings/upload-logo.action";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LOGO_MAX_BYTES,
  LOGO_MIME_TYPES,
  LOGO_MIN_SIDE_PX,
  type LogoRejectDetail,
  type LogoRejectReason,
} from "@/types/billing";

const ACCEPT = LOGO_MIME_TYPES.join(",");
const DRAFT_CONFLICT_MESSAGE =
  "Another user changed the draft — reload to see it.";
const FAILED_MESSAGE = "The logo could not be uploaded. Please try again.";

function kb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

// The inline Danger text for each `LOGO_REJECTED` reason.
export function logoRejectMessage(
  reason: LogoRejectReason,
  detail: LogoRejectDetail,
): string {
  switch (reason) {
    case "size":
      return typeof detail.byteSize === "number" && detail.byteSize > 0
        ? `The file is ${kb(detail.byteSize)}; the limit is ${kb(LOGO_MAX_BYTES)}.`
        : "The file is empty.";
    case "mime":
      return `The file is not a valid PNG, JPEG or SVG matching its type${
        detail.declared ? ` (${detail.declared})` : ""
      }.`;
    case "dimensions":
      return typeof detail.width === "number" &&
        typeof detail.height === "number"
        ? `The image is ${detail.width}×${detail.height} px; the shorter side must be at least ${LOGO_MIN_SIDE_PX} px.`
        : `${String(detail.message ?? "The image size could not be read")}.`;
    case "svg_content":
      return `The SVG contains ${String(detail.construct)}, which is not allowed.`;
  }
}

export interface LogoUploadFieldProps {
  // The stored logo's GET-route URL, or `null`.
  logoSrc: string | null;
  // The working draft's token; `null` when no draft exists yet.
  draftToken: string | null;
  // Why the field is disabled even with a draft (e.g. unsaved form edits).
  blockedReason?: string | null;
  // D8 — offer "Use the current app logo" (no logo asset exists yet).
  showImport?: boolean;
  // bm61 D5 — a message from outside the field (e.g. the activation's
  // `PROFILE_LOGO_REQUIRED`), shown inline in Danger when the field has no
  // error of its own.
  externalError?: string | null;
}

export function LogoUploadField({
  logoSrc,
  draftToken,
  blockedReason = null,
  showImport = false,
  externalError = null,
}: LogoUploadFieldProps): React.JSX.Element {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const disabledReason =
    draftToken === null ? "Save the draft first." : blockedReason;
  const disabled = disabledReason !== null || busy;

  async function settle(
    pending: Promise<UploadLogoActionResult>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await pending;
      if (result.ok) {
        // The action revalidated the layout; the page re-renders with the
        // stored version (and the draft's new token).
        toast.success(
          `Logo v${result.versionNo} added to draft v${result.draftVersion}`,
        );
        return;
      }
      switch (result.code) {
        case "LOGO_REJECTED":
          setError(logoRejectMessage(result.reason, result.detail));
          break;
        case "DRAFT_CONFLICT":
          toast.warning(DRAFT_CONFLICT_MESSAGE, {
            action: { label: "Reload", onClick: () => router.refresh() },
          });
          break;
        case "ACTIVATION_BLOB_CONFLICT":
          setError("A different file is already stored at this path.");
          break;
        case "APP_LOGO_UNAVAILABLE":
          setError("The app logo could not be read.");
          break;
        case "FORBIDDEN":
          toast.error("You do not have permission to upload the logo.");
          break;
        default:
          toast.error(FAILED_MESSAGE);
      }
    } catch {
      toast.error(FAILED_MESSAGE);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function upload(file: File): void {
    if (disabled || draftToken === null) return;
    // Fast feedback only — the server re-checks every byte.
    if (file.size === 0 || file.size > LOGO_MAX_BYTES) {
      setError(logoRejectMessage("size", { byteSize: file.size }));
      return;
    }
    if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(logoRejectMessage("mime", { declared: file.type || null }));
      return;
    }
    const form = new FormData();
    form.set("file", file);
    form.set("expectedDraftToken", draftToken);
    void settle(uploadLogoAction(form));
  }

  return (
    <div className="space-y-2">
      <div
        data-testid="logo-dropzone"
        aria-disabled={disabled || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) upload(file);
        }}
        className={cn(
          "flex flex-col items-start gap-3 border border-dashed border-[color:var(--border-strong)] bg-[color:var(--surface-sunken)] p-4 focus-within:[box-shadow:var(--focus-ring)]",
          dragOver && "border-[color:var(--color-primary-500)]",
          disabled && "opacity-70",
        )}
      >
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- the stored logo is served by the session-guarded GET route (bm56 D3); next/image would proxy it past the route's CSP/no-store headers.
          <img
            src={logoSrc}
            alt="Company logo"
            className="max-h-20 max-w-[240px] border border-[color:var(--border-subtle)] bg-white p-1"
          />
        ) : (
          <span className="text-body-sm text-muted-foreground">No logo</span>
        )}
        <p className="text-body-sm text-muted-foreground">
          PNG, JPEG or SVG, up to 500 KB, at least {LOGO_MIN_SIDE_PX} px on the
          shorter side. Drop a file here or choose one.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id="profile-logo-file"
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? "Uploading…" : "Choose file"}
          </Button>
          {showImport ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                if (draftToken !== null) {
                  void settle(
                    importAppLogoAction({ expectedDraftToken: draftToken }),
                  );
                }
              }}
            >
              Use the current app logo
            </Button>
          ) : null}
        </div>
        {disabledReason ? (
          <p className="text-body-sm text-muted-foreground">{disabledReason}</p>
        ) : null}
      </div>
      {(error ?? externalError) ? (
        <p
          role="alert"
          className="text-body-sm text-[color:var(--color-danger-700)]"
        >
          {error ?? externalError}
        </p>
      ) : null}
    </div>
  );
}
