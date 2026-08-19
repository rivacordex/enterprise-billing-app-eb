import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { RUN_STATUSES, type RunStatus } from "@/types/billing";

// bm02-spec §6/§8. The badge maps all 11 RunStatus values to a labelled,
// icon-paired chip (meaning never depends on colour alone — ui-context
// §"Rendering rule").

const EXPECTED_LABEL: Record<RunStatus, string> = {
  SCHEDULED: "Scheduled",
  PROCESSING: "Processing",
  PROCESSED: "Processed",
  APPROVED: "Approved",
  POSTING: "Posting",
  INVOICED: "Invoiced",
  DISTRIBUTING: "Distributing",
  COMPLETED: "Completed",
  PROCESSING_FAILED: "Processing failed",
  DISTRIBUTION_FAILED: "Distribution failed",
  CANCELLED: "Cancelled",
};

describe("RunStatusBadge (bm02-spec §6)", () => {
  it("covers all 11 RunStatus values", () => {
    expect(RUN_STATUSES).toHaveLength(11);
  });

  it.each(RUN_STATUSES)("renders %s with a label and an icon", (status) => {
    const { container } = render(<RunStatusBadge status={status} />);
    expect(container.textContent).toContain(EXPECTED_LABEL[status]);
    // Icon + label pairing — every badge carries an svg.
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
