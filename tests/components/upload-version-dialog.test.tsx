import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
vi.mock("@/actions/product/upload-ratecard-version.action", () => ({
  uploadRatecardVersionAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { UploadVersionDialog } from "@/components/products/rate-card/upload-version-dialog";

beforeEach(() => {
  mockRefresh.mockReset();
});

async function open() {
  const user = userEvent.setup();
  render(
    <UploadVersionDialog
      trigger={<button>Open</button>}
      cardNames={["RAN_USAGE"]}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
}

describe("UploadVersionDialog (pm66 review fixes)", () => {
  it("the file-picker prompt says 'click', not misleading drag-and-drop copy (finding D)", async () => {
    await open();
    expect(screen.getByText("Click to choose a CSV file")).toBeInTheDocument();
    expect(screen.queryByText(/Drop a CSV/)).not.toBeInTheDocument();
  });

  it("mounts a persistent role=status live region, empty until a failure (finding C)", async () => {
    await open();
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    // Persistently mounted and empty before any structural failure — so a later
    // failure summary is announced rather than the region appearing fresh.
    expect(status).toHaveTextContent("");
  });

  it("renders an uncontrolled file input and a native cardName field (D1)", async () => {
    await open();
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[name="file"][type="file"]',
    );
    expect(fileInput).not.toBeNull();
    // Uncontrolled — no React `value` bound to the file input.
    expect(fileInput?.getAttribute("value")).toBeNull();
    expect(document.querySelector('[name="cardName"]')).not.toBeNull();
  });
});
