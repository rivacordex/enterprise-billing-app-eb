import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AuditLogTable } from "@/components/audit-log/audit-log-table";
import type { AuditLogRow } from "@/types/audit-log";

function row(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    auditId: "audit-1",
    eventType: "USER_CREATED",
    category: "Additive",
    actorUserId: "user-1",
    actorUserName: "Admin User",
    actorDeleted: false,
    targetEntity: "APPUSER",
    targetId: "user-2",
    beforeData: null,
    afterData: { userName: "New User" },
    createdDatetime: new Date("2026-06-17T09:14:22.000Z"),
    ...overrides,
  };
}

describe("AuditLogTable", () => {
  it("renders the empty state when rows is []", () => {
    render(<AuditLogTable rows={[]} />);
    expect(screen.getByText("No audit events found")).toBeInTheDocument();
  });

  it("renders a row with the category badge, event type, and chevron button", () => {
    render(<AuditLogTable rows={[row()]} />);
    expect(screen.getByText("Additive")).toBeInTheDocument();
    expect(screen.getByText("USER_CREATED")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show event detail" }),
    ).toBeInTheDocument();
  });

  it("shows the actor's user_name for an active, non-deleted actor", () => {
    render(<AuditLogTable rows={[row()]} />);
    expect(screen.getByText("Admin User")).toBeInTheDocument();
  });

  it('shows the name plus "(deleted)" for a deleted actor with a name', () => {
    render(<AuditLogTable rows={[row({ actorDeleted: true })]} />);
    expect(screen.getByText("Admin User")).toBeInTheDocument();
    expect(screen.getByText("(deleted)")).toBeInTheDocument();
  });

  it("shows a truncated UUID plus (deleted) for a deleted actor with no name", () => {
    render(
      <AuditLogTable
        rows={[
          row({
            actorUserId: "12345678-aaaa-bbbb-cccc-dddddddddddd",
            actorUserName: null,
            actorDeleted: true,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/12345678… \(deleted\)/)).toBeInTheDocument();
  });

  it("toggles the detail row open on chevron click, with aria-expanded reflecting state", async () => {
    const user = userEvent.setup();
    render(<AuditLogTable rows={[row()]} />);

    const toggle = screen.getByRole("button", { name: "Show event detail" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Hide event detail" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide event detail" }));
    expect(
      screen.getByRole("button", { name: "Show event detail" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
  });

  it("renders null before_data as the literal string 'null'", async () => {
    const user = userEvent.setup();
    render(<AuditLogTable rows={[row({ beforeData: null })]} />);
    await user.click(screen.getByRole("button", { name: "Show event detail" }));
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("renders non-null after_data as formatted JSON", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuditLogTable rows={[row({ afterData: { foo: "bar" } })]} />,
    );
    await user.click(screen.getByRole("button", { name: "Show event detail" }));
    const pres = container.querySelectorAll("pre");
    const afterPre = Array.from(pres).find((el) =>
      el.textContent?.includes('"foo"'),
    );
    expect(afterPre?.textContent).toBe(JSON.stringify({ foo: "bar" }, null, 2));
  });

  it("tracks expand state independently across multiple rows", async () => {
    const user = userEvent.setup();
    render(
      <AuditLogTable
        rows={[row({ auditId: "audit-1" }), row({ auditId: "audit-2" })]}
      />,
    );

    const toggles = screen.getAllByRole("button", {
      name: "Show event detail",
    });
    await user.click(toggles[0]!);

    const expanded = screen.getAllByRole("button", {
      name: "Hide event detail",
    });
    expect(expanded).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Show event detail" }),
    ).toHaveLength(1);
  });

  it("formats the timestamp as 'YYYY-MM-DD HH:mm:ss UTC'", () => {
    render(<AuditLogTable rows={[row()]} />);
    expect(screen.getByText("2026-06-17 09:14:22 UTC")).toBeInTheDocument();
  });
});
