import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/administration/audit-log",
  useSearchParams: () => mockSearchParams,
}));

import { AuditLogFilters } from "@/components/audit-log/audit-log-filters";
import type { AuditLogActorOption } from "@/types/audit-log";

const ACTORS: AuditLogActorOption[] = [
  { userId: "user-1", userName: "Admin User", isDeleted: false },
  { userId: "user-2", userName: "Gone User", isDeleted: true },
];

beforeEach(() => {
  mockReplace.mockReset();
  mockSearchParams = new URLSearchParams();
});

describe("AuditLogFilters", () => {
  it("renders all controls at their defaults with no Clear button when no filters are active", () => {
    render(<AuditLogFilters actors={ACTORS} />);
    expect(screen.getByLabelText("Event type")).toHaveValue("");
    expect(screen.getByLabelText("Actor")).toHaveValue("");
    expect(screen.getByLabelText("From date")).toHaveValue("");
    expect(screen.getByLabelText("To date")).toHaveValue("");
    expect(screen.queryByText("Clear")).not.toBeInTheDocument();
  });

  it("renders all 23 event types under the correct optgroup", () => {
    render(<AuditLogFilters actors={ACTORS} />);
    const select = screen.getByLabelText("Event type");
    const additive = within(select).getByRole("group", { name: "Additive" });
    expect(within(additive).getByText("USER_CREATED")).toBeInTheDocument();
    expect(within(additive).getByText("ROLE_ASSIGNED")).toBeInTheDocument();
    expect(
      within(additive).getByText("ORGANIZATION_CREATED"),
    ).toBeInTheDocument();
    expect(within(additive).getByText("CUSTOMER_CREATED")).toBeInTheDocument();

    const change = within(select).getByRole("group", { name: "Change" });
    expect(
      within(change).getByText("ORGANIZATION_UPDATED"),
    ).toBeInTheDocument();

    const security = within(select).getByRole("group", { name: "Security" });
    expect(within(security).getByText("USER_LOCKED")).toBeInTheDocument();

    expect(within(select).getAllByRole("option")).toHaveLength(24); // "All events" + 23
  });

  it('renders a tombstoned actor option with a "(deleted)" suffix', () => {
    render(<AuditLogFilters actors={ACTORS} />);
    expect(screen.getByText("Gone User (deleted)")).toBeInTheDocument();
  });

  it("Apply calls router.replace with the selected eventType and page reset to 1", async () => {
    const user = userEvent.setup();
    render(<AuditLogFilters actors={ACTORS} />);

    await user.selectOptions(
      screen.getByLabelText("Event type"),
      "USER_CREATED",
    );
    await user.click(screen.getByText("Apply"));

    expect(mockReplace).toHaveBeenCalledWith(
      "/administration/audit-log?eventType=USER_CREATED&page=1",
    );
  });

  it("Clear button appears when eventType is present in the URL", () => {
    mockSearchParams = new URLSearchParams({ eventType: "USER_CREATED" });
    render(<AuditLogFilters actors={ACTORS} />);
    expect(screen.getByText("Clear")).toBeInTheDocument();
  });

  it("Clear calls router.replace(pathname) with no query string", async () => {
    mockSearchParams = new URLSearchParams({ eventType: "USER_CREATED" });
    const user = userEvent.setup();
    render(<AuditLogFilters actors={ACTORS} />);

    await user.click(screen.getByText("Clear"));

    expect(mockReplace).toHaveBeenCalledWith("/administration/audit-log");
  });
});
