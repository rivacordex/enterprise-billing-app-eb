import { toHttpResponse } from "@/lib/http";
import { validationFailed } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { handleStatusPush } from "@/services/billing/handle-status-push";
import { runIdParamSchema } from "@/validation/billing/stage-signal.schema";
import { statusPushBodySchema } from "@/validation/billing/status-push.schema";

// bm04-spec §Implementation §7, code-standards §5. The run-level M2M push —
// same session-less auth order as the stage-complete handler.
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

    const bodyResult = statusPushBodySchema.safeParse(await request.json());
    if (!bodyResult.success) {
      throw validationFailed("Invalid status-push body.");
    }

    const result = await handleStatusPush({ runId: runIdResult.data });

    return Response.json({ data: result }, { status: 200 });
  } catch (err) {
    return toHttpResponse(err);
  }
}
