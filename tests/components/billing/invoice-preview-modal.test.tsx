// bm18-spec §Implementation §4, Phase-2 review folds D-T2 (loading/queued/
// error states) and D-T5 (watermark legibility + modal a11y, shared with
// bm19). `Dialog` (Radix) already provides focus trap/Esc/focus-return — this
// suite covers the loading→ready/queued/error state machine driven by
// `fetch`, plus the trigger's quiet-ghost styling (ui-context §7) and the
// iframe's accessible title.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InvoicePreviewModal,
  StoredInvoiceModal,
} from "@/components/billing/invoice-preview-modal";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderModal() {
  return render(
    <InvoicePreviewModal
      billRunId="BRN00000001"
      billingAccountId="BAN00000001"
      accountName="Acme Communications"
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("InvoicePreviewModal", () => {
  it("renders a quiet ghost trigger, never the featured petrol or a danger role (ui-context §7)", () => {
    renderModal();

    const trigger = screen.getByRole("button", {
      name: /preview pro-forma/i,
    });
    expect(trigger.getAttribute("data-variant")).toBe("ghost");
  });

  it("shows an immediate PDF-shaped skeleton with a rendering caption on open (D-T2)", async () => {
    const { promise } = deferred<Response>();
    vi.mocked(fetch).mockReturnValue(promise as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Rendering draft invoice…")).toBeTruthy();
  });

  it("shows the rendered PDF in a titled iframe once the fetch resolves", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      blob: () =>
        Promise.resolve(new Blob(["pdf"], { type: "application/pdf" })),
    } as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));

    const iframe = await screen.findByTitle(
      "Draft PRO-FORMA invoice — BAN00000001",
    );
    expect(iframe.getAttribute("src")).toBe("blob:mock-url");
    expect(fetch).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/draft-invoice/BAN00000001",
      expect.anything(),
    );
  });

  it("shows an inline retry with a plain-language reason on a forbidden response, never a frozen/empty modal (D-T2)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));

    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
  });

  it("shows a not-found reason for a 404 (no draft bill yet)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));

    expect(
      await screen.findByText(/no draft bill found for this account yet/i),
    ).toBeTruthy();
  });

  it("shows a rate-limit reason for a 429", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));

    expect(await screen.findByText(/too many preview requests/i)).toBeTruthy();
  });

  it("re-renders successfully when Retry is clicked after a failure", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob(["pdf"])),
      } as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));
    await screen.findByRole("button", { name: /^retry$/i });

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));

    await screen.findByTitle("Draft PRO-FORMA invoice — BAN00000001");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("switches the caption to 'Queued — rendering shortly' once a render outlasts a normal one (D-T2)", async () => {
    vi.useFakeTimers();
    const { promise } = deferred<Response>();
    vi.mocked(fetch).mockReturnValue(promise as never);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /preview pro-forma/i }));
    expect(screen.getByText("Rendering draft invoice…")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByText("Queued — rendering shortly")).toBeTruthy();
  });
});

// bm19-spec §Implementation §5 — `StoredInvoiceModal`: no watermark/preview
// banner (this IS the issued record), the real INV number + blob_ref/
// checksum read from the download response's headers, and a Download link —
// shares D-T5's a11y contract via the same `Dialog`.
function renderStoredModal() {
  return render(
    <StoredInvoiceModal
      billRunId="BRN00000001"
      billingAccountId="BAN00000001"
      accountName="Acme Communications"
    />,
  );
}

function storedResponse(headers: Record<string, string>) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    blob: () => Promise.resolve(new Blob(["pdf"], { type: "application/pdf" })),
  };
}

describe("StoredInvoiceModal", () => {
  it("fetches the session-guarded stored-invoice route on open", async () => {
    vi.mocked(fetch).mockResolvedValue(
      storedResponse({
        "X-Invoice-Number": "INV00000001",
        "X-Blob-Ref": "invoices/2026-07/INV00000001.pdf",
        "X-Checksum": "abc123",
      }) as never,
    );
    renderStoredModal();

    fireEvent.click(screen.getByRole("button", { name: /stored invoice/i }));

    await screen.findByTitle("Invoice INV00000001");
    expect(fetch).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/stored-invoice/BAN00000001",
      expect.anything(),
    );
  });

  it("shows the real invoice number and the PDF-bytes blob_ref/checksum (Design 'two checksums, two purposes')", async () => {
    vi.mocked(fetch).mockResolvedValue(
      storedResponse({
        "X-Invoice-Number": "INV00000042",
        "X-Blob-Ref": "invoices/2026-07/INV00000042.pdf",
        "X-Checksum": "deadbeef",
      }) as never,
    );
    renderStoredModal();

    fireEvent.click(screen.getByRole("button", { name: /stored invoice/i }));

    expect(
      await screen.findByText("invoices/2026-07/INV00000042.pdf"),
    ).toBeTruthy();
    expect(screen.getByText("deadbeef")).toBeTruthy();
    expect(screen.getByTitle("Invoice INV00000042")).toBeTruthy();
  });

  it("offers a Download link once the stored PDF is retrieved", async () => {
    vi.mocked(fetch).mockResolvedValue(
      storedResponse({
        "X-Invoice-Number": "INV00000001",
        "X-Blob-Ref": "invoices/2026-07/INV00000001.pdf",
        "X-Checksum": "abc123",
      }) as never,
    );
    renderStoredModal();

    fireEvent.click(screen.getByRole("button", { name: /stored invoice/i }));

    const download = await screen.findByRole("link", { name: /download/i });
    expect(download.getAttribute("href")).toBe("blob:mock-url");
  });

  it("shows a not-found reason for a 404 (no stored invoice yet)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as never);
    renderStoredModal();

    fireEvent.click(screen.getByRole("button", { name: /stored invoice/i }));

    expect(
      await screen.findByText(/no stored invoice found for this account yet/i),
    ).toBeTruthy();
  });
});
