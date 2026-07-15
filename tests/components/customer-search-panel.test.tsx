import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

import { CustomerSearchPanel } from "@/components/customers/customer-search-panel";

function lastReplacedUrl(): string {
  const calls = mockReplace.mock.calls;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) throw new Error("router.replace was never called");
  return lastCall[0] as string;
}

beforeEach(() => {
  mockReplace.mockReset();
});

describe("CustomerSearchPanel", () => {
  it("typing + Apply navigates to ?q=<term> via router.replace", async () => {
    const user = userEvent.setup();
    render(<CustomerSearchPanel query="" baseHref="/customers/view" />);

    await user.type(
      screen.getByLabelText("Search customers by organization or trading name"),
      "Acme",
    );
    await user.click(screen.getByText("Apply"));

    expect(lastReplacedUrl()).toBe("/customers/view?q=Acme");
  });

  it("pressing Enter applies the search the same way", async () => {
    const user = userEvent.setup();
    render(<CustomerSearchPanel query="" baseHref="/customers/view" />);

    await user.type(
      screen.getByLabelText("Search customers by organization or trading name"),
      "Acme{Enter}",
    );

    expect(lastReplacedUrl()).toBe("/customers/view?q=Acme");
  });

  it("Clear removes q entirely and clears the local field", async () => {
    const user = userEvent.setup();
    render(<CustomerSearchPanel query="Acme" baseHref="/customers/view" />);

    const input = screen.getByLabelText(
      "Search customers by organization or trading name",
    ) as HTMLInputElement;
    expect(input.value).toBe("Acme");

    await user.click(screen.getByText("Clear"));

    expect(lastReplacedUrl()).toBe("/customers/view");
    expect(input.value).toBe("");
  });

  it("Clear button is absent when query is empty", () => {
    render(<CustomerSearchPanel query="" baseHref="/customers/view" />);
    expect(screen.queryByText("Clear")).not.toBeInTheDocument();
  });

  it("pending state disables both Apply and Clear", async () => {
    // Force `useTransition`'s pending flag to stay true (its real transition
    // resolves synchronously in this test env since `router.replace` is a
    // plain mock, so asserting the disabled state requires pinning it).
    vi.resetModules();
    vi.doMock("react", async (importOriginal) => {
      const actual = await importOriginal<typeof ReactModule>();
      return {
        ...actual,
        useTransition: () => [true, (cb: () => void) => cb()],
      };
    });
    const { CustomerSearchPanel: PendingPanel } =
      await import("@/components/customers/customer-search-panel");

    render(<PendingPanel query="Acme" baseHref="/customers/view" />);

    expect(screen.getByText("Apply")).toBeDisabled();
    expect(screen.getByText("Clear")).toBeDisabled();
    expect(
      screen.getByLabelText("Search customers by organization or trading name"),
    ).toBeDisabled();

    vi.doUnmock("react");
    vi.resetModules();
  });
});
