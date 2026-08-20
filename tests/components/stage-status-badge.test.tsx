import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { StageStatusBadge } from "@/components/billing/stage-status-badge";
import { STAGE_STATUSES, type StageStatus } from "@/types/billing";

// bm04-spec §Visual. Icon + label pairing for every `StageStatus`, plus the
// `null` (no signal yet) → PENDING fallback (get-stage-timeline.ts).

const EXPECTED_LABEL: Record<StageStatus, string> = {
  PENDING: "Pending",
  RUNNING: "Running",
  DONE: "Done",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

describe("StageStatusBadge", () => {
  it("covers all 5 StageStatus values", () => {
    expect(STAGE_STATUSES).toHaveLength(5);
  });

  it.each(STAGE_STATUSES)("renders %s with a label and an icon", (status) => {
    const { container } = render(<StageStatusBadge status={status} />);
    expect(container.textContent).toContain(EXPECTED_LABEL[status]);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders null status as the neutral Pending badge", () => {
    const { container } = render(<StageStatusBadge status={null} />);
    expect(container.textContent).toContain("Pending");
  });
});
