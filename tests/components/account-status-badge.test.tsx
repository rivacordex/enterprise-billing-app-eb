import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { AccountStatusBadge } from "@/components/billing/account-status-badge";
import { ACCOUNT_STATUSES, type AccountStatus } from "@/types/billing";

const EXPECTED_LABEL: Record<AccountStatus, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  PROCESSED: "Processed",
  INVOICED: "Invoiced",
  DISTRIBUTING: "Distributing",
  COMPLETED: "Completed",
  PROCESSING_FAILED: "Processing failed",
  DISTRIBUTION_FAILED: "Distribution failed",
  SKIPPED: "Skipped",
  EXCLUDED: "Excluded",
};

describe("AccountStatusBadge (code-standards §4.1 — ships with bm04)", () => {
  it("covers all 10 AccountStatus values", () => {
    expect(ACCOUNT_STATUSES).toHaveLength(10);
  });

  it.each(ACCOUNT_STATUSES)("renders %s with a label and an icon", (status) => {
    const { container } = render(<AccountStatusBadge status={status} />);
    expect(container.textContent).toContain(EXPECTED_LABEL[status]);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
