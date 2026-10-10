// bm57-spec (optimistic concurrency), reused by bm59–bm61 — the one message
// every Invoice Settings draft surface shows on `DRAFT_CONFLICT`. A shared
// draft is never last-writer-wins.
export const DRAFT_CONFLICT_MESSAGE =
  "Another user changed the draft — reload to see it.";
