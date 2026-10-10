// bm58-spec §Tests (components): the shared `ActivateVersionDialog`. Per the
// 2026-10-10 owner decision (ui-context §7) the confirm button is the standard
// primary button and stays disabled until a change note is entered; a server
// refusal renders inline in Danger; the summary and warning render; a successful
// confirm sends the TRIMMED note and closes.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivateVersionDialog } from "@/components/billing/invoice-settings/activate-version-dialog";

const onConfirm = vi.fn();
const onOpenChange = vi.fn();

function renderDialog(
  props: Partial<React.ComponentProps<typeof ActivateVersionDialog>> = {},
) {
  return render(
    <ActivateVersionDialog
      open
      onOpenChange={onOpenChange}
      title="Activate template v3"
      confirmLabel="Activate v3"
      summary={<p>No change in structure.</p>}
      onConfirm={onConfirm}
      {...props}
    />,
  );
}

beforeEach(() => {
  onConfirm.mockReset();
  onOpenChange.mockReset();
});

describe("ActivateVersionDialog", () => {
  it("shows the title and the what-changes summary", () => {
    renderDialog({
      summary: (
        <ul>
          <li>+ Usage annex shown</li>
        </ul>
      ),
    });
    expect(screen.getByText("Activate template v3")).toBeInTheDocument();
    expect(screen.getByTestId("activate-summary")).toHaveTextContent(
      "+ Usage annex shown",
    );
  });

  it("renders an optional warning callout", () => {
    renderDialog({ warning: "Bank details change on every new invoice" });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Bank details change on every new invoice",
    );
  });

  it("keeps the confirm button disabled until a non-blank change note is entered", () => {
    renderDialog();
    const confirm = screen.getByRole("button", { name: "Activate v3" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "   " },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "Hide notes" },
    });
    expect(confirm).toBeEnabled();
  });

  it("uses the standard primary button, not the Deep Petrol accent (ui-context §7)", () => {
    renderDialog();
    const confirm = screen.getByRole("button", { name: "Activate v3" });
    expect(confirm.className).not.toContain("billrun-cta");
    expect(confirm).toHaveAttribute("data-variant", "default");
  });

  it("counts the note against the 500 limit", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "abcde" },
    });
    expect(screen.getByText("5 / 500")).toBeInTheDocument();
    expect(screen.getByLabelText(/Change note/)).toHaveAttribute(
      "maxlength",
      "500",
    );
  });

  it("sends the trimmed note and closes on success", async () => {
    onConfirm.mockResolvedValue({ ok: true });
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "  Hide notes  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate v3" }));
    });
    expect(onConfirm).toHaveBeenCalledWith("Hide notes");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders a server refusal inline in Danger and stays open", async () => {
    onConfirm.mockResolvedValue({
      ok: false,
      message: "Another user changed the draft — reload to see it.",
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "note" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate v3" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another user changed the draft",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows a generic error when the confirm call throws", async () => {
    onConfirm.mockRejectedValue(new Error("network"));
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Change note/), {
      target: { value: "note" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activate v3" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "could not be activated",
    );
  });

  it("cancel closes without confirming", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
