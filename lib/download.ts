// Shared browser file-download mechanism. Client-only (touches `document` and
// `URL`), so call it from event handlers in `"use client"` components, never
// server-side. Extracted so the CSV export controls (bill-runs, uncharged, GL
// journal) share one implementation of the anchor lifecycle + deferred
// object-URL revocation instead of hand-rolling it in each component.

// Streams a Blob (e.g. a `fetch` response body) to a file download.
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revocation so the browser can initiate the download first — a
  // synchronous revoke can cancel a larger download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Downloads in-memory CSV text as a UTF-8 `text/csv` file.
export function downloadCsv(csv: string, filename: string): void {
  triggerBlobDownload(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    filename,
  );
}
