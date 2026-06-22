// um30-spec §"6. /api/health endpoint". Liveness/readiness probe target —
// intentionally does no DB query so a transient DB blip never trips the
// probe and triggers a cascading restart. `/api/health/db` (not yet
// implemented) is reserved for an actual DB-connectivity check.
export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    version: process.env.BUILD_VERSION ?? "local",
  });
}
