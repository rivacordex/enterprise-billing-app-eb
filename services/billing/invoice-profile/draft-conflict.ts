// Thrown inside a company-profile write transaction to roll it back when the
// working draft moved on (or the pointer could not be set); the caller catches
// it and returns `DRAFT_CONFLICT`. Shared by bm60 upload and bm61 activation.
export class DraftConflict extends Error {
  constructor() {
    super("DRAFT_CONFLICT");
  }
}
