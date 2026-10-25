import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// bm77-spec §8 / code-standards › Invoice Template Types, Next.js rule 4 —
// `CreateTemplateTypeDialog`: Create stays disabled until the trimmed name is
// 3–60 characters; success navigates to the new type's detail page; ANY
// `ok: false` shows the field (or generic) error and re-fetches the page with
// `router.refresh()`, keeping the dialog and its error on screen.

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock(
  "@/actions/billing/invoice-settings/create-template-type.action",
  () => ({ createTemplateTypeAction: vi.fn() }),
);

import { createTemplateTypeAction } from "@/actions/billing/invoice-settings/create-template-type.action";
import { CreateTemplateTypeDialog } from "@/components/billing/invoice-settings/create-template-type-dialog";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";

const mockCreate = vi.mocked(createTemplateTypeAction);

function openAndType(name: string): void {
  render(<CreateTemplateTypeDialog />);
  fireEvent.click(
    screen.getByRole("button", { name: "New invoice template type" }),
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: name },
  });
}

async function clickCreate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateTemplateTypeDialog (bm77)", () => {
  it("keeps Create disabled until the trimmed name is at least 3 characters", () => {
    openAndType("  ab  ");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Wholesale" },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("on success navigates to the new type's detail page, with no refresh", async () => {
    mockCreate.mockResolvedValue({ ok: true, typeId: "BTF00000002" });
    openAndType("Wholesale");
    await clickCreate();
    expect(mockCreate).toHaveBeenCalledWith({ name: "Wholesale" });
    expect(push).toHaveBeenCalledWith(
      "/administration/invoice-settings/invoice-template/BTF00000002",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a taken name shows the field error under the input and refreshes the page", async () => {
    mockCreate.mockResolvedValue({
      ok: false,
      code: "TEMPLATE_TYPE_NAME_TAKEN",
      fieldErrors: { name: [TEMPLATE_TYPE_MESSAGES.nameTaken] },
    });
    openAndType("Wholesale");
    await clickCreate();
    expect(screen.getByRole("alert")).toHaveTextContent(
      TEMPLATE_TYPE_MESSAGES.nameTaken,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    // The dialog stays open with the name the user typed.
    expect(screen.getByLabelText("Name")).toHaveValue("Wholesale");
  });

  it.each([
    ["FORBIDDEN", TEMPLATE_TYPE_MESSAGES.createForbidden],
    ["SERVER_ERROR", TEMPLATE_TYPE_MESSAGES.createFailed],
  ] as const)(
    "%s shows its generic message and refreshes the page",
    async (code, message) => {
      mockCreate.mockResolvedValue({ ok: false, code });
      openAndType("Wholesale");
      await clickCreate();
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );
});
