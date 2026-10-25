// bm78 review fix (code-standards › Invoice Template Types, Next.js rule 4) —
// `UploadLayoutDialog` re-fetches the page on EVERY `ok: false`, keeping each
// code's message / problem list; a refusal whose re-fetch reveals an open
// layout DRAFT keeps its message visible. bm80: an open layout DRAFT turns the
// dialog into the overwrite `AlertDialog` with the exact warning from server
// data, and the request names the warned-about DRAFT.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), success: vi.fn() } }));
vi.mock(
  "@/actions/billing/invoice-settings/upload-layout-package.action",
  () => ({ uploadLayoutPackageAction: vi.fn() }),
);

import { toast } from "sonner";

import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import {
  OVERWRITE_WARNING,
  RESTORE_NOTE,
  TEMPLATE_TYPE_MESSAGES,
} from "@/components/billing/invoice-settings/template-type-messages";
import { UploadLayoutDialog } from "@/components/billing/invoice-settings/upload-layout-dialog";
import { formatDatetime } from "@/lib/formatters";
import type { OpenLayoutDraftInfo } from "@/types/billing";

const mockUpload = vi.mocked(uploadLayoutPackageAction);
const PROPS = {
  familyId: "BTF00000002",
  nextVersionNo: 1,
  locale: "en-MY",
  timezone: "Asia/Kuala_Lumpur",
};
const MODIFIED = new Date("2026-10-25T03:04:05.000Z");
const OPEN_DRAFT: OpenLayoutDraftInfo = {
  versionId: "BTV00000010",
  versionNo: 1,
  token: "2026-10-25T03:04:05.123456Z",
  lastModifiedDatetime: MODIFIED,
  lastModifiedByName: "Aisyah",
};
const FORMATTED = formatDatetime(MODIFIED, PROPS.locale, PROPS.timezone);

function openTrigger(): void {
  fireEvent.click(
    screen.getByRole("button", { name: TEMPLATE_TYPE_MESSAGES.uploadTrigger }),
  );
}

async function submit(confirm = "Create draft v1"): Promise<void> {
  openTrigger();
  fireEvent.change(
    screen.getByLabelText(TEMPLATE_TYPE_MESSAGES.uploadFileLabel),
    {
      target: {
        files: [new File([new Uint8Array([0x50, 0x4b])], "layout.zip")],
      },
    },
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: confirm }));
  });
}

function sentForm(): FormData {
  const call = mockUpload.mock.calls[0];
  if (!call) throw new Error("the action was not called");
  return call[0];
}

beforeEach(() => {
  refresh.mockReset();
  mockUpload.mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe("UploadLayoutDialog — refusals (bm78 review fix)", () => {
  it.each([
    [
      "LAYOUT_REJECTED",
      {
        ok: false,
        code: "LAYOUT_REJECTED",
        problems: [
          {
            file: "partials/header.hbs",
            code: "LAYOUT_MISSING_REQUIRED_BLOCKS",
            message: "the header has no TIN",
          },
        ],
      },
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
    ],
    [
      "FORBIDDEN",
      { ok: false, code: "FORBIDDEN", problems: [] },
      TEMPLATE_TYPE_MESSAGES.uploadForbidden,
    ],
    [
      "SERVER_ERROR",
      { ok: false, code: "SERVER_ERROR", problems: [] },
      TEMPLATE_TYPE_MESSAGES.uploadFailed,
    ],
    [
      "TEMPLATE_TYPE_RETIRED",
      { ok: false, code: "TEMPLATE_TYPE_RETIRED", problems: [] },
      TEMPLATE_TYPE_MESSAGES.uploadTypeRetired,
    ],
  ] as const)(
    "%s keeps its message or problems and re-fetches the page",
    async (_code, result, shown) => {
      mockUpload.mockResolvedValue(result as never);
      render(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
      await submit();
      expect(screen.getByText(shown)).toBeInTheDocument();
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it("DRAFT_CHANGED_SINCE_WARNING stays visible after the re-fetch reveals an open layout draft, which turns the dialog into the warning (bm80)", async () => {
    mockUpload.mockResolvedValue({
      ok: false,
      code: "DRAFT_CHANGED_SINCE_WARNING",
      problems: [],
    });
    const { rerender } = render(
      <UploadLayoutDialog {...PROPS} openLayoutDraft={null} />,
    );
    await submit();
    expect(refresh).toHaveBeenCalledOnce();
    // The refreshed page now carries another user's layout DRAFT.
    rerender(<UploadLayoutDialog {...PROPS} openLayoutDraft={OPEN_DRAFT} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByTestId("overwrite-warning")).toHaveTextContent(
      OVERWRITE_WARNING(1, FORMATTED, "Aisyah"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      TEMPLATE_TYPE_MESSAGES.uploadDraftChanged,
    );
    // The selected file belonged to the old state: the confirm waits for a
    // new one.
    expect(
      screen.getByRole("button", {
        name: TEMPLATE_TYPE_MESSAGES.overwriteConfirm,
      }),
    ).toBeDisabled();
    // Owner decision — also a Warning toast, which survives a remount (an
    // empty type's dialog moves from the empty-state alert to the heading).
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      TEMPLATE_TYPE_MESSAGES.uploadDraftChanged,
    );
  });

  it("success closes, toasts the created draft and re-fetches", async () => {
    mockUpload.mockResolvedValue({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: false,
    });
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
    await submit();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Draft v1 created");
  });

  it("bm80 — without an open draft the FormData carries no expected-draft fields", async () => {
    mockUpload.mockResolvedValue({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: false,
    });
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
    await submit();
    expect(sentForm().has("expectedDraftVersionId")).toBe(false);
    expect(sentForm().has("expectedDraftToken")).toBe(false);
  });
});

describe("UploadLayoutDialog — overwrite an open draft (bm80)", () => {
  it("shows the exact warning (version, formatted date, user) in an AlertDialog with the Overwrite draft confirm in the danger role", () => {
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={OPEN_DRAFT} />);
    openTrigger();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByTestId("overwrite-warning")).toHaveTextContent(
      `This type already has a draft (layout v1, last changed ${FORMATTED} by Aisyah). Uploading will overwrite the existing draft layout. Your draft settings (Payment and footnote) are kept.`,
    );
    const confirm = screen.getByRole("button", { name: "Overwrite draft" });
    expect(confirm).toHaveAttribute("data-variant", "destructive");
    expect(confirm).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Create draft v1" }),
    ).toBeNull();
  });

  it.each([
    ["a deleted uploader", "a deleted user", "a deleted user"],
    ["no recorded writer", null, "an unknown user"],
  ] as const)("%s shows %s", (_c, name, shown) => {
    render(
      <UploadLayoutDialog
        {...PROPS}
        openLayoutDraft={{ ...OPEN_DRAFT, lastModifiedByName: name }}
      />,
    );
    openTrigger();
    expect(screen.getByTestId("overwrite-warning")).toHaveTextContent(
      OVERWRITE_WARNING(1, FORMATTED, shown),
    );
  });

  it("the FormData carries both expected fields from the prop; success toasts the replace", async () => {
    mockUpload.mockResolvedValue({
      ok: true,
      versionId: "BTV00000010",
      versionNo: 1,
      replaced: true,
    });
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={OPEN_DRAFT} />);
    await submit("Overwrite draft");
    expect(sentForm().get("familyId")).toBe("BTF00000002");
    expect(sentForm().get("expectedDraftVersionId")).toBe("BTV00000010");
    expect(sentForm().get("expectedDraftToken")).toBe(OPEN_DRAFT.token);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Draft v1 replaced");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("DRAFT_CHANGED_SINCE_WARNING shows the reason, re-fetches, and warns again with the new server data", async () => {
    mockUpload.mockResolvedValue({
      ok: false,
      code: "DRAFT_CHANGED_SINCE_WARNING",
      problems: [],
    });
    const { rerender } = render(
      <UploadLayoutDialog {...PROPS} openLayoutDraft={OPEN_DRAFT} />,
    );
    await submit("Overwrite draft");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The draft changed since this warning was shown. Review the updated warning and try again.",
    );
    expect(refresh).toHaveBeenCalledOnce();
    // Another manager overwrote it meanwhile: a newer token, another author.
    const later = new Date("2026-10-25T05:00:00.000Z");
    rerender(
      <UploadLayoutDialog
        {...PROPS}
        openLayoutDraft={{
          ...OPEN_DRAFT,
          token: "2026-10-25T05:00:00.654321Z",
          lastModifiedDatetime: later,
          lastModifiedByName: "Ben",
        }}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByTestId("overwrite-warning")).toHaveTextContent(
      OVERWRITE_WARNING(
        1,
        formatDatetime(later, PROPS.locale, PROPS.timezone),
        "Ben",
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      TEMPLATE_TYPE_MESSAGES.overwriteStale,
    );
  });
});

describe("UploadLayoutDialog — restore note (bm81)", () => {
  const SETTINGS = {
    exportFormat: 1,
    source: {
      typeCode: "WHOLESALE",
      typeName: "Wholesale",
      layoutVersion: 3,
      settingsVersion: 4,
      status: "ACTIVE",
      layoutChecksum: "a".repeat(64),
      exportedAt: "2026-10-25T01:02:03.000Z",
      exportedBy: "Exporter",
    },
    structure: {
      sections: { payment: true },
      columns: {},
      footnote: ["Restored footnote"],
    },
  };
  const enc = (text: string) => new TextEncoder().encode(text);

  function zipWith(settings: string | null): File {
    const entries: Record<string, Uint8Array> = {
      "manifest.json": enc("{}"),
    };
    if (settings !== null) entries["settings.json"] = enc(settings);
    return new File([zipSync(entries)], "export.zip", {
      type: "application/zip",
    });
  }

  async function choose(file: File): Promise<void> {
    await act(async () => {
      fireEvent.change(
        screen.getByLabelText(TEMPLATE_TYPE_MESSAGES.uploadFileLabel),
        { target: { files: [file] } },
      );
    });
    // Let the browser-side read settle, so a "no note" is not vacuous.
    await act(() => new Promise((r) => setTimeout(r, 50)));
  }

  it.each([
    ["the create Dialog", null],
    ["the overwrite AlertDialog", OPEN_DRAFT],
  ] as const)(
    "a zip with a valid settings.json shows the note and 'Restored from v3' in %s",
    async (_c, openLayoutDraft) => {
      render(
        <UploadLayoutDialog {...PROPS} openLayoutDraft={openLayoutDraft} />,
      );
      openTrigger();
      await choose(zipWith(JSON.stringify(SETTINGS)));
      const note = await screen.findByTestId("restore-note");
      expect(note).toHaveTextContent(RESTORE_NOTE);
      expect(note).toHaveTextContent("Restored from v3");
    },
  );

  it.each([
    ["no settings.json", null],
    [
      "an invalid settings.json",
      JSON.stringify({ ...SETTINGS, exportFormat: 2 }),
    ],
    ["a settings.json that is not JSON", "{not json"],
    [
      "a valid settings.json over 64 KiB (never inflated)",
      JSON.stringify(SETTINGS) + " ".repeat(64 * 1024),
    ],
  ])("a zip with %s shows no note", async (_c, settings) => {
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
    openTrigger();
    await choose(zipWith(settings));
    expect(screen.queryByTestId("restore-note")).toBeNull();
  });

  it("a non-zip file shows no note", async () => {
    render(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
    openTrigger();
    await choose(new File([enc("not a zip")], "layout.zip"));
    expect(screen.queryByTestId("restore-note")).toBeNull();
  });
});
