# error/

Bind-mounted stand-in for the Azure Blob `error` container (rm04-spec D4).
Reject files with reason codes — 24-month retention
(`infra/bicep/modules/rating-engine-storage.bicep`). Per-batch reject files
are written by rm07/rm09; rm04 only makes this location exist.
