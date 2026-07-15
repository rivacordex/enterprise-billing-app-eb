import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusTransitionControl } from "@/components/customers/status-transition-control";

const mockOnConflict = vi.fn();

beforeEach(() => {
  mockOnConflict.mockReset();
});

describe("StatusTransitionControl", () => {
  it("renders no dropdown for a terminal status (nextStates: [])", () => {
    render(
      <StatusTransitionControl
        currentStatus="DISSOLVED"
        entityKind="organization"
        nextStates={[]}
        onTransition={vi.fn()}
        onConflict={mockOnConflict}
      />,
    );

    expect(screen.getByText("Dissolved")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
  });

  it("selecting a target reveals the reason field and Apply, both required before Apply is enabled", async () => {
    const user = userEvent.setup();
    render(
      <StatusTransitionControl
        currentStatus="REGISTERED"
        entityKind="organization"
        nextStates={["ACTIVE", "DISSOLVED"]}
        onTransition={vi.fn()}
        onConflict={mockOnConflict}
      />,
    );

    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Active" }));

    const reasonField = screen.getByLabelText("Reason");
    const applyButton = screen.getByRole("button", { name: "Apply" });
    expect(reasonField).toBeInTheDocument();
    expect(applyButton).toBeDisabled();

    await user.type(reasonField, "Trading confirmed.");
    expect(applyButton).toBeEnabled();
  });

  it("each option renders the leading color swatch for its own target status", async () => {
    const user = userEvent.setup();
    render(
      <StatusTransitionControl
        currentStatus="REGISTERED"
        entityKind="organization"
        nextStates={["ACTIVE", "DISSOLVED"]}
        onTransition={vi.fn()}
        onConflict={mockOnConflict}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const activeOption = await screen.findByRole("option", { name: "Active" });
    expect(
      activeOption.querySelector(
        ".bg-\\[color\\:var\\(--color-success-500\\)\\]",
      ),
    ).not.toBeNull();

    const dissolvedOption = screen.getByRole("option", { name: "Dissolved" });
    expect(
      dissolvedOption.querySelector(
        ".bg-\\[color\\:var\\(--color-neutral-500\\)\\]",
      ),
    ).not.toBeNull();
  });

  it("a CONFLICT response swaps in the optimistic-lock conflict banner", async () => {
    const user = userEvent.setup();
    const onTransition = vi
      .fn()
      .mockResolvedValue({ ok: false, code: "CONFLICT" });

    render(
      <StatusTransitionControl
        currentStatus="REGISTERED"
        entityKind="organization"
        nextStates={["ACTIVE", "DISSOLVED"]}
        onTransition={onTransition}
        onConflict={mockOnConflict}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Active" }));
    await user.type(screen.getByLabelText("Reason"), "Trading confirmed.");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(mockOnConflict).toHaveBeenCalled();
  });
});
