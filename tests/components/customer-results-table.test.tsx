import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerResultsTable } from "@/components/customers/customer-results-table";
import type {
  CustomerSearchResult,
  CustomerSearchResults,
} from "@/types/customer";

function makeResult(
  overrides: Partial<CustomerSearchResult> = {},
): CustomerSearchResult {
  return {
    partyRoleId: "PTRL000001",
    organizationId: "ORG000001",
    organizationName: "Acme Corp",
    tradingName: "Acme",
    organizationStatus: "ACTIVE",
    customerStatus: "ACTIVE",
    ...overrides,
  };
}

function makeResults(
  overrides: Partial<CustomerSearchResults> = {},
): CustomerSearchResults {
  return {
    results: [makeResult()],
    hasMore: false,
    limit: 5,
    query: "Acme",
    ...overrides,
  };
}

describe("CustomerResultsTable", () => {
  it("renders the empty-state message and no table when there are zero results", () => {
    render(
      <CustomerResultsTable
        results={makeResults({ results: [] })}
        basePath="/customers/view"
      />,
    );

    expect(
      screen.getByText("No customers match your search."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders the five columns and a badge per row for each result", () => {
    render(
      <CustomerResultsTable
        results={makeResults()}
        basePath="/customers/view"
      />,
    );

    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Trading Name")).toBeInTheDocument();
    expect(screen.getByText("Organization Status")).toBeInTheDocument();
    expect(screen.getByText("Customer Status")).toBeInTheDocument();
    expect(screen.getByText("Customer ID")).toBeInTheDocument();

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("PTRL000001")).toBeInTheDocument();
    expect(screen.getAllByText("Active", { selector: "span" })).toHaveLength(2);
  });

  it("renders — for a null trading name", () => {
    render(
      <CustomerResultsTable
        results={makeResults({ results: [makeResult({ tradingName: null })] })}
        basePath="/customers/view"
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("mutes a row with customerStatus CLOSED", () => {
    render(
      <CustomerResultsTable
        results={makeResults({
          results: [makeResult({ customerStatus: "CLOSED" })],
        })}
        basePath="/customers/view"
      />,
    );

    const row = screen.getByText("Acme Corp").closest("tr");
    expect(row?.className).toContain("text-muted-foreground");
  });

  it("mutes a row with organizationStatus DISSOLVED", () => {
    render(
      <CustomerResultsTable
        results={makeResults({
          results: [makeResult({ organizationStatus: "DISSOLVED" })],
        })}
        basePath="/customers/view"
      />,
    );

    const row = screen.getByText("Acme Corp").closest("tr");
    expect(row?.className).toContain("text-muted-foreground");
  });

  it("mutes a row with organizationStatus MERGED", () => {
    render(
      <CustomerResultsTable
        results={makeResults({
          results: [makeResult({ organizationStatus: "MERGED" })],
        })}
        basePath="/customers/view"
      />,
    );

    const row = screen.getByText("Acme Corp").closest("tr");
    expect(row?.className).toContain("text-muted-foreground");
  });

  it("does not mute an ACTIVE/ACTIVE row", () => {
    render(
      <CustomerResultsTable
        results={makeResults()}
        basePath="/customers/view"
      />,
    );

    const row = screen.getByText("Acme Corp").closest("tr");
    expect(row?.className).not.toContain("text-muted-foreground");
  });

  it("renders the refine-search hint with the correct limit when hasMore is true", () => {
    render(
      <CustomerResultsTable
        results={makeResults({ hasMore: true, limit: 5 })}
        basePath="/customers/view"
      />,
    );

    expect(
      screen.getByText(
        "Showing the first 5 matches — refine your search for more precise results.",
      ),
    ).toBeInTheDocument();
  });

  it("renders no hint when hasMore is false", () => {
    render(
      <CustomerResultsTable
        results={makeResults({ hasMore: false })}
        basePath="/customers/view"
      />,
    );

    expect(screen.queryByText(/refine your search/)).not.toBeInTheDocument();
  });

  it("each row's organization-name link points to basePath/partyRoleId", () => {
    render(
      <CustomerResultsTable
        results={makeResults()}
        basePath="/customers/manage"
      />,
    );

    expect(screen.getByText("Acme Corp").closest("a")).toHaveAttribute(
      "href",
      "/customers/manage/PTRL000001",
    );
  });
});
