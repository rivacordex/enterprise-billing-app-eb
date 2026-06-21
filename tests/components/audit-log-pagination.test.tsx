import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams({ eventType: "USER_CREATED" });

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/administration/audit-log",
  useSearchParams: () => mockSearchParams,
}));

import { AuditLogPagination } from "@/components/audit-log/audit-log-pagination";

beforeEach(() => {
  mockReplace.mockReset();
  mockSearchParams = new URLSearchParams({ eventType: "USER_CREATED" });
});

describe("AuditLogPagination", () => {
  it("page 1 of 3: Previous disabled, Next enabled, correct range label", () => {
    render(<AuditLogPagination total={120} page={1} pageSize={50} />);
    expect(screen.getByText("Showing 1–50 of 120 events")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("page 2 of 3: both buttons enabled, correct range label", () => {
    render(<AuditLogPagination total={120} page={2} pageSize={50} />);
    expect(
      screen.getByText("Showing 51–100 of 120 events"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("page 3 of 3: Previous enabled, Next disabled, correct range label", () => {
    render(<AuditLogPagination total={120} page={3} pageSize={50} />);
    expect(
      screen.getByText("Showing 101–120 of 120 events"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("zero results: 'Showing 0–0 of 0 events', both buttons disabled", () => {
    render(<AuditLogPagination total={0} page={1} pageSize={50} />);
    expect(screen.getByText("Showing 0–0 of 0 events")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("Next click calls router.replace with page incremented, preserving other params", async () => {
    const user = userEvent.setup();
    render(<AuditLogPagination total={120} page={1} pageSize={50} />);

    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(mockReplace).toHaveBeenCalledWith(
      "/administration/audit-log?eventType=USER_CREATED&page=2",
    );
  });

  it("Previous click calls router.replace with page decremented, preserving other params", async () => {
    const user = userEvent.setup();
    render(<AuditLogPagination total={120} page={2} pageSize={50} />);

    await user.click(screen.getByRole("button", { name: "Previous page" }));

    expect(mockReplace).toHaveBeenCalledWith(
      "/administration/audit-log?eventType=USER_CREATED&page=1",
    );
  });
});
