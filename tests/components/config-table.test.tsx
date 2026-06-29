import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/system-config/config-edit-dialog", () => ({
  ConfigEditDialog: (props: { configKey: string }) => (
    <button type="button" data-testid={`edit-${props.configKey}`}>
      Edit
    </button>
  ),
}));

import { ConfigTable } from "@/components/system-config/config-table";
import type {
  SystemConfigDisplayRow,
  SystemConfigGroup,
} from "@/types/system-config";

function row(
  overrides: Partial<SystemConfigDisplayRow>,
): SystemConfigDisplayRow {
  return {
    configId: "id-1",
    configGroup: "app",
    configVersion: 1,
    configKey: "app_name",
    configValue: "Enterprise Billing System",
    description: null,
    isSecret: false,
    status: "ACTIVE",
    modifiedByUserId: null,
    modifiedByName: null,
    lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ConfigTable", () => {
  it("renders the empty state with no table when groups is []", () => {
    const { container } = render(<ConfigTable timezone="UTC" groups={[]} />);
    expect(screen.getByText("No configuration parameters")).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders a group header and both rows for a single group with two rows", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [
          row({ configId: "1", configKey: "app_name", configValue: "Foo" }),
          row({ configId: "2", configKey: "app_version", configValue: "1.0" }),
        ],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("app_name")).toBeInTheDocument();
    expect(screen.getByText("app_version")).toBeInTheDocument();
    expect(screen.getByText("Foo")).toBeInTheDocument();
    expect(screen.getByText("1.0")).toBeInTheDocument();
  });

  it("renders the seeded description as a sublabel under the key (um28)", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [
          row({
            configKey: "locale",
            description: "BCP-47 locale for date/number formatting.",
          }),
        ],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("locale")).toBeInTheDocument();
    expect(
      screen.getByText("BCP-47 locale for date/number formatting."),
    ).toBeInTheDocument();
  });

  it("renders no description sublabel when description is null (um28)", () => {
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ configKey: "x", description: null })] },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    // The key cell holds only the mono key, no second <p> sublabel.
    const keyCell = screen.getByText("x").closest("td");
    expect(keyCell?.querySelector("p")).toBeNull();
  });

  it("truncates a value longer than 80 characters and sets the full value as title", () => {
    const longValue = "x".repeat(81);
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ configValue: longValue })] },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    const cell = screen.getByText(longValue);
    expect(cell).toHaveClass("truncate");
    expect(cell).toHaveAttribute("title", longValue);
  });

  it("renders a URI-shaped value in font-mono", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [row({ configValue: "https://example.com/callback" })],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("https://example.com/callback")).toHaveClass(
      "font-mono",
    );
  });

  it('shows "by {name}" when modifiedByName is non-null', () => {
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ modifiedByName: "Jane Admin" })] },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("by Jane Admin")).toBeInTheDocument();
  });

  it('does not show "by ..." when modifiedByName is null', () => {
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ modifiedByName: null })] },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });

  it("applies opacity-60 to a RETIRED row", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [row({ status: "RETIRED", configKey: "old_key" })],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("old_key").closest("tr")).toHaveClass("opacity-60");
  });

  it("renders only the rows it receives (filtering is the repository's responsibility)", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [row({ configKey: "visible_key", isSecret: false })],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} />);
    expect(screen.getByText("visible_key")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + group header + 1 data row
  });

  it("canEdit=false (default): no Actions column and group header colSpan is 4", () => {
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ configKey: "app_name" })] },
    ];
    const { container } = render(
      <ConfigTable timezone="UTC" groups={groups} />,
    );
    expect(screen.queryByTestId("edit-app_name")).not.toBeInTheDocument();
    expect(container.querySelector("td[colspan]")).toHaveAttribute(
      "colspan",
      "4",
    );
  });

  it("canEdit=true: Actions header appears and group header colSpan is 5", () => {
    const groups: SystemConfigGroup[] = [
      { group: "app", rows: [row({ configKey: "app_name" })] },
    ];
    const { container } = render(
      <ConfigTable timezone="UTC" groups={groups} canEdit />,
    );
    expect(container.querySelectorAll("th")).toHaveLength(5);
    expect(container.querySelector("td[colspan]")).toHaveAttribute(
      "colspan",
      "5",
    );
  });

  it("canEdit=true: renders a ConfigEditDialog per row with the correct props", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "billing",
        rows: [
          row({
            configId: "id-9",
            configKey: "currency",
            configGroup: "billing",
            configValue: "USD",
          }),
        ],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} canEdit />);
    expect(screen.getByTestId("edit-currency")).toBeInTheDocument();
  });

  it("canEdit=true: RETIRED rows still render the ConfigEditDialog", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [row({ configKey: "old_key", status: "RETIRED" })],
      },
    ];
    render(<ConfigTable timezone="UTC" groups={groups} canEdit />);
    expect(screen.getByTestId("edit-old_key")).toBeInTheDocument();
  });

  it("canEdit=true, empty groups: empty-state renders, no table or Actions column", () => {
    const { container } = render(
      <ConfigTable timezone="UTC" groups={[]} canEdit />,
    );
    expect(screen.getByText("No configuration parameters")).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });

  // um29-spec §2.7: the "Last Modified" cell's machine-readable `dateTime`
  // attribute stays ISO-8601 UTC, while the human-visible hover `title`
  // shows the configured-zone instant (here +08 ⇒ 8-hour shift).
  it("renders dateTime as ISO-UTC and title in the configured zone", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [
          row({ lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z") }),
        ],
      },
    ];
    const { container } = render(
      <ConfigTable timezone="Asia/Kuala_Lumpur" groups={groups} />,
    );
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-01-01T00:00:00.000Z");
    expect(time).toHaveAttribute("title", "2026-01-01 08:00:00 (GMT+8)");
  });

  it("keeps the literal ' UTC' title suffix when the zone is UTC", () => {
    const groups: SystemConfigGroup[] = [
      {
        group: "app",
        rows: [
          row({ lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z") }),
        ],
      },
    ];
    const { container } = render(
      <ConfigTable timezone="UTC" groups={groups} />,
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "title",
      "2026-01-01 00:00:00 UTC",
    );
  });
});
