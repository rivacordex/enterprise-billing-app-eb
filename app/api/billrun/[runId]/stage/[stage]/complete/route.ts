import { toHttpResponse } from "@/lib/http";
import { validationFailed } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { handleStageSignal } from "@/services/billing/handle-stage-signal";
import {
  runIdParamSchema,
  stageParamSchema,
  stageSignalBodySchema,
} from "@/validation/billing/stage-signal.schema";

// bm04-spec §Implementation §7, code-standards §5. Session-less M2M ingest —
// no session lookup, ever (architecture Inv. #9). Auth order: bearer check
// (401) → Zod-parse params + body (422) → run-PROCESSING guard, delegated to
// the service (409) → delegate. No business logic here.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ runId: string; stage: string }> },
): Promise<Response> {
  try {
    requireServiceToken(request);

    const { runId: rawRunId, stage: rawStage } = await ctx.params;
    const runIdResult = runIdParamSchema.safeParse(rawRunId);
    const stageResult = stageParamSchema.safeParse(rawStage);
    if (!runIdResult.success || !stageResult.success) {
      throw validationFailed("Invalid run id or stage.");
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // Malformed JSON is a client error (422), not an internal 500.
      throw validationFailed("Invalid stage-signal body.");
    }
    const bodyResult = stageSignalBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      throw validationFailed("Invalid stage-signal body.");
    }
    const body = bodyResult.data;

    const result = await handleStageSignal({
      runId: runIdResult.data,
      stage: stageResult.data,
      banId: body.ban_id,
      attempt: body.attempt,
      status: body.status,
      ...(body.error_class !== undefined && { errorClass: body.error_class }),
      ...(body.error_code !== undefined && { errorCode: body.error_code }),
      ...(body.error_detail !== undefined && {
        errorDetail: body.error_detail,
      }),
    });

    return Response.json({ data: result }, { status: 200 });
  } catch (err) {
    return toHttpResponse(err);
  }
}
