import { toHttpResponse } from "@/lib/http";
import { validationFailed } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { recordDistributionOutcome } from "@/services/billing/distribute-run";
import { runIdParamSchema } from "@/validation/billing/stage-signal.schema";
import { distributionOutcomeBodySchema } from "@/validation/billing/distribution-outcome.schema";

// bm20-spec §Implementation §4, code-standards §5 (the sanctioned THIRD M2M
// handler — architecture decision recorded there). Session-less M2M ingest,
// same auth order as the other two: bearer check (401) → Zod-parse params +
// body (422) → run-DISTRIBUTING guard, delegated to the service (409) →
// delegate. No business logic here. One outcome per POST — a duplicate
// `(run, target, artifact_ref, distribution_attempt)` replays 200 no-op.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    requireServiceToken(request);

    const { runId: rawRunId } = await ctx.params;
    const runIdResult = runIdParamSchema.safeParse(rawRunId);
    if (!runIdResult.success) {
      throw validationFailed("Invalid run id.");
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // Malformed JSON is a client error (422), not an internal 500.
      throw validationFailed("Invalid distribution-outcome body.");
    }
    const bodyResult = distributionOutcomeBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      throw validationFailed("Invalid distribution-outcome body.");
    }
    const body = bodyResult.data;

    const result = await recordDistributionOutcome({
      runId: runIdResult.data,
      target: body.target,
      artifactRef: body.artifact_ref,
      artifactType: body.artifact_type,
      isMandatory: body.is_mandatory,
      outcome: body.outcome,
      attempt: body.attempt,
    });

    return Response.json({ data: result }, { status: 200 });
  } catch (err) {
    return toHttpResponse(err);
  }
}
