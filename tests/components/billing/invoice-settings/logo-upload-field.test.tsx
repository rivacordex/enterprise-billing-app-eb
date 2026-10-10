// bm60-spec §Tests: `LogoUploadField` — disabled without a draft ("Save the
// draft first") or with unsaved edits; a server rejection shows its reason
// inline in Danger; the client pre-check refuses an oversized or wrong-type
// file without calling the server; the preview is the GET route, never a
// `blob:` URL; a drop uploads with the draft token; the D8 import action.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/billing/invoice-settings/upload-logo.action", () => ({
  uploadLogoAction: vi.fn(),
  importAppLogoAction: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import {
  importAppLogoAction,
  uploadLogoAction,
} from "@/actions/billing/invoice-settings/upload-logo.action";
import {
  LogoUploadField,
  logoRejectMessage,
} from "@/components/billing/invoice-settings/logo-upload-field";

const TOKEN = "2026-10-10T01:02:03.123456Z";
const SRC =
  "/administration/invoice-settings/company-profile/logo/INVASV00000001";
const mockUpload = vi.mocked(uploadLogoAction);

function fileInput(): HTMLInputElement {
  return document.getElementById("profile-logo-file") as HTMLInputElement;
}

function choose(file: File): void {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

const PNG = new File([new Uint8Array(1000)], "logo.png", {
  type: "image/png",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LogoUploadField", () => {
  it("is disabled without a draft and says to save the draft first", () => {
    render(<LogoUploadField logoSrc={null} draftToken={null} />);
    expect(screen.getByText("Save the draft first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeDisabled();
    expect(fileInput()).toBeDisabled();
    expect(screen.getByTestId("logo-dropzone")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("is disabled while the form has unsaved edits", () => {
    render(
      <LogoUploadField
        logoSrc={null}
        draftToken={TOKEN}
        blockedReason="Save your changes first."
      />,
    );
    expect(screen.getByText("Save your changes first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeDisabled();
  });

  it("previews the stored version through the GET route, never a blob: URL", () => {
    render(<LogoUploadField logoSrc={SRC} draftToken={TOKEN} />);
    const img = screen.getByRole("img", { name: "Company logo" });
    expect(img).toHaveAttribute("src", SRC);
    expect(img.getAttribute("src")).not.toMatch(/^blob:/);
  });

  it("uploads the chosen file with the draft token as FormData", async () => {
    mockUpload.mockResolvedValue({
      ok: true,
      assetVersionId: "INVASV00000002",
      versionNo: 2,
      draftVersion: 5,
      draftToken: TOKEN,
    });
    render(<LogoUploadField logoSrc={null} draftToken={TOKEN} />);
    choose(PNG);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    const fd = mockUpload.mock.calls[0]![0];
    expect(fd.get("file")).toBe(PNG);
    expect(fd.get("expectedDraftToken")).toBe(TOKEN);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Logo v2 added to draft v5"),
    );
  });

  it("uploads a dropped file", async () => {
    mockUpload.mockResolvedValue({ ok: false, code: "SERVER_ERROR" });
    render(<LogoUploadField logoSrc={null} draftToken={TOKEN} />);
    fireEvent.drop(screen.getByTestId("logo-dropzone"), {
      dataTransfer: { files: [PNG] },
    });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
  });

  it.each([
    [
      "size",
      { byteSize: 600_000, maxBytes: 512_000 },
      /586 KB; the limit is 500 KB/,
    ],
    [
      "mime",
      { declared: "image/png", detected: "image/svg+xml" },
      /not a valid PNG, JPEG or SVG/,
    ],
    [
      "dimensions",
      { width: 200, height: 900 },
      /200×900 px; the shorter side must be at least 300 px/,
    ],
    [
      "svg_content",
      { construct: "<script>" },
      /contains <script>, which is not allowed/,
    ],
  ] as const)(
    "shows a %s rejection inline in Danger",
    async (reason, detail, text) => {
      mockUpload.mockResolvedValue({
        ok: false,
        code: "LOGO_REJECTED",
        reason,
        detail,
      });
      render(<LogoUploadField logoSrc={null} draftToken={TOKEN} />);
      choose(PNG);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert.className).toContain("--color-danger-700");
    },
  );

  it("pre-checks size and type client-side without calling the server", async () => {
    render(<LogoUploadField logoSrc={null} draftToken={TOKEN} />);
    choose(
      new File([new Uint8Array(600_000)], "big.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/limit/);
    choose(new File(["GIF89a"], "a.gif", { type: "image/gif" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid/);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("DRAFT_CONFLICT is a Warning toast with Reload", async () => {
    mockUpload.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    render(<LogoUploadField logoSrc={null} draftToken={TOKEN} />);
    choose(PNG);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const options = vi.mocked(toast.warning).mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Reload");
    options.action.onClick();
    expect(refresh).toHaveBeenCalled();
  });

  it("offers the app-logo import only when asked, and runs it with the token", async () => {
    vi.mocked(importAppLogoAction).mockResolvedValue({
      ok: false,
      code: "LOGO_REJECTED",
      reason: "dimensions",
      detail: { message: "SVG width/height must be unitless or px" },
    });
    const { rerender } = render(
      <LogoUploadField logoSrc={null} draftToken={TOKEN} />,
    );
    expect(
      screen.queryByRole("button", { name: "Use the current app logo" }),
    ).toBeNull();
    rerender(<LogoUploadField logoSrc={null} draftToken={TOKEN} showImport />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current app logo" }),
    );
    expect(importAppLogoAction).toHaveBeenCalledWith({
      expectedDraftToken: TOKEN,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SVG width/height must be unitless or px.",
    );
  });

  it("logoRejectMessage covers an empty file", () => {
    expect(logoRejectMessage("size", { byteSize: 0 })).toBe(
      "The file is empty.",
    );
  });
});
