import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ErrorClassBadge } from "@/components/billing/error-class-badge";
import { ERROR_CLASSES, type ErrorClass } from "@/types/billing";

const EXPECTED_LABEL: Record<ErrorClass, string> = {
  HARD: "Hard",
  SOFT: "Soft",
  INFRA: "Infra",
};

describe("ErrorClassBadge", () => {
  it("covers all 3 ErrorClass values", () => {
    expect(ERROR_CLASSES).toHaveLength(3);
  });

  it.each(ERROR_CLASSES)(
    "renders %s with a label and an icon",
    (errorClass) => {
      const { container } = render(<ErrorClassBadge errorClass={errorClass} />);
      expect(container.textContent).toContain(EXPECTED_LABEL[errorClass]);
      expect(container.querySelector("svg")).not.toBeNull();
    },
  );
});
