import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TempPasswordDisplay } from "@/components/users/temp-password-display";

const TEMP_PASSWORD = "abc123XYZ_-789defgh01";

describe("TempPasswordDisplay", () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the temp password inside a code element", () => {
    render(
      <TempPasswordDisplay tempPassword={TEMP_PASSWORD} onDone={vi.fn()} />,
    );
    const code = screen.getByText(TEMP_PASSWORD);
    expect(code.tagName).toBe("CODE");
  });

  it("shows the will-not-be-shown-again warning", () => {
    render(
      <TempPasswordDisplay tempPassword={TEMP_PASSWORD} onDone={vi.fn()} />,
    );
    expect(
      screen.getAllByText(/will not be shown again/i).length,
    ).toBeGreaterThan(0);
  });

  it("copies the password and reverts the label after 2 seconds", () => {
    vi.useFakeTimers();
    render(
      <TempPasswordDisplay tempPassword={TEMP_PASSWORD} onDone={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy password" }));

    expect(writeTextMock).toHaveBeenCalledWith(TEMP_PASSWORD);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(
      screen.getByRole("button", { name: "Copy password" }),
    ).toBeInTheDocument();
  });

  it("calls onDone when Done is clicked", () => {
    const onDone = vi.fn();
    render(
      <TempPasswordDisplay tempPassword={TEMP_PASSWORD} onDone={onDone} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
