// bm78 review fix (code-standards › Invoice Template Types, Next.js rule 4) —
// `UploadLayoutDialog` re-fetches the page on EVERY `ok: false`, keeping each
// code's message / problem list; a refusal whose re-fetch reveals an open
// layout DRAFT (the Dialog unmounts) keeps its message visible.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
vi.mock(
  "@/actions/billing/invoice-settings/upload-layout-package.action",
  () => ({ uploadLayoutPackageAction: vi.fn() }),
);

import { toast } from "sonner";

import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
import { UploadLayoutDialog } from "@/components/billing/invoice-settings/upload-layout-dialog";

const mockUpload = vi.mocked(uploadLayoutPackageAction);
const PROPS = { familyId: "BTF00000002", nextVersionNo: 1 };

async function submit(): Promise<void> {
  fireEvent.click(
    screen.getByRole("button", { name: TEMPLATE_TYPE_MESSAGES.uploadTrigger }),
  );
  fireEvent.change(
    screen.getByLabelText(TEMPLATE_TYPE_MESSAGES.uploadFileLabel),
    {
      target: {
        files: [new File([new Uint8Array([0x50, 0x4b])], "layout.zip")],
      },
    },
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create draft v1" }));
  });
}

beforeEach(() => {
  refresh.mockReset();
  mockUpload.mockReset();
  vi.mocked(toast.warning).mockReset();
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

  it("DRAFT_CHANGED_SINCE_WARNING stays visible after the re-fetch reveals an open layout draft", async () => {
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
    rerender(
      <UploadLayoutDialog
        {...PROPS}
        openLayoutDraft={{ versionId: "BTV00000010", versionNo: 1 }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      TEMPLATE_TYPE_MESSAGES.uploadDraftChanged,
    );
    // Owner decision — also a Warning toast, which survives a remount (an
    // empty type's dialog moves from the empty-state alert to the heading).
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      TEMPLATE_TYPE_MESSAGES.uploadDraftChanged,
    );
  });

  it("review fix — once the revealed draft is gone, the Dialog does not re-open by itself, and a new open starts clean", async () => {
    mockUpload.mockResolvedValue({
      ok: false,
      code: "DRAFT_CHANGED_SINCE_WARNING",
      problems: [],
    });
    const { rerender } = render(
      <UploadLayoutDialog {...PROPS} openLayoutDraft={null} />,
    );
    await submit();
    rerender(
      <UploadLayoutDialog
        {...PROPS}
        openLayoutDraft={{ versionId: "BTV00000010", versionNo: 1 }}
      />,
    );
    // That draft is discarded: the trigger is back, and nothing pops open.
    rerender(<UploadLayoutDialog {...PROPS} openLayoutDraft={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: TEMPLATE_TYPE_MESSAGES.uploadTrigger,
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create draft v1" }),
    ).toBeDisabled();
  });

  it("success closes and re-fetches", async () => {
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
  });
});
