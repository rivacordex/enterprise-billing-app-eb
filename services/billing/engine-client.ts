import { billRunEngineConfig, isBillRunEngineConfigured } from "@/lib/config";
import { logger } from "@/lib/logger";

// bm03-spec §Design/Implementation §5. The outbound workflow engine is
// **treated as not-yet-deployed** (project decision) — a mockable client so
// the trigger transaction is fully testable with no live engine. Framework-
// agnostic (no `next/*`), imported only by `services/billing/trigger-run.ts`
// (code-standards §1.3).

export interface TriggerPayload {
  bill_run_id: string;
  period_start: string;
  period_end: string;
  ban_ids: string[];
  attempt: number;
  gl_event_at: string;
}

export interface ExecutionRef {
  executionId: string;
  definitionId: string;
  definitionRevision: number;
}

// bm12-spec §Design/§Implementation §2. The engine's ground-truth execution
// state, polled by "Check status" (`services/billing/reconcile-run.ts`) and
// killed by "Cancel run" (`services/billing/cancel-run.ts`).
export const EXECUTION_STATES = [
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "KILLED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutionStatus {
  state: ExecutionState;
}

export interface EngineClient {
  startExecution(payload: TriggerPayload): Promise<ExecutionRef>;
  getExecutionStatus(executionId: string): Promise<ExecutionStatus>;
  killExecution(executionId: string): Promise<void>;
}

export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
  }
}

const ENGINE_NAMESPACE = "billing";
const ENGINE_DEFINITION = "bill_run";
const REQUEST_TIMEOUT_MS = 15_000;

interface RawExecutionResponse {
  executionId?: string;
  definitionId?: string;
  definitionRevision?: number;
}

export const realEngineClient: EngineClient = {
  async startExecution(payload: TriggerPayload): Promise<ExecutionRef> {
    if (!billRunEngineConfig.url || !billRunEngineConfig.auth) {
      throw new EngineError(
        "realEngineClient invoked without BILLRUN_ENGINE_URL/BILLRUN_ENGINE_AUTH configured.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${billRunEngineConfig.url}/executions/${ENGINE_NAMESPACE}/${ENGINE_DEFINITION}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(billRunEngineConfig.auth).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new EngineError("Bill-run engine request failed.", { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new EngineError(
        `Bill-run engine returned ${response.status} for run ${payload.bill_run_id}.`,
      );
    }

    const body = (await response.json()) as RawExecutionResponse;
    if (!body.executionId) {
      throw new EngineError(
        `Bill-run engine response for run ${payload.bill_run_id} is missing executionId.`,
      );
    }

    return {
      executionId: body.executionId,
      definitionId:
        body.definitionId ?? `${ENGINE_NAMESPACE}.${ENGINE_DEFINITION}`,
      definitionRevision: body.definitionRevision ?? 0,
    };
  },

  // bm12-spec §Design/§Implementation §2. FLAGGED: the status/kill endpoint
  // paths below (`/executions/{id}` GET, `/executions/{id}/kill` DELETE) are
  // this unit's best guess at Kestra's execution API — they must be verified
  // against the deployed engine version before this real client is wired up
  // (plan §13 open item).
  async getExecutionStatus(executionId: string): Promise<ExecutionStatus> {
    if (!billRunEngineConfig.url || !billRunEngineConfig.auth) {
      throw new EngineError(
        "realEngineClient invoked without BILLRUN_ENGINE_URL/BILLRUN_ENGINE_AUTH configured.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${billRunEngineConfig.url}/executions/${executionId}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(billRunEngineConfig.auth).toString("base64")}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw new EngineError("Bill-run engine status request failed.", {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new EngineError(
        `Bill-run engine returned ${response.status} for execution ${executionId} status.`,
      );
    }

    const body = (await response.json()) as { state?: string };
    if (
      body.state !== "RUNNING" &&
      body.state !== "SUCCESS" &&
      body.state !== "FAILED" &&
      body.state !== "KILLED"
    ) {
      throw new EngineError(
        `Bill-run engine returned an unrecognized state for execution ${executionId}.`,
      );
    }

    return { state: body.state };
  },

  // bm12-spec §Design/§Implementation §2. Same "verify against the deployed
  // engine" flag as `getExecutionStatus` above.
  async killExecution(executionId: string): Promise<void> {
    if (!billRunEngineConfig.url || !billRunEngineConfig.auth) {
      throw new EngineError(
        "realEngineClient invoked without BILLRUN_ENGINE_URL/BILLRUN_ENGINE_AUTH configured.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${billRunEngineConfig.url}/executions/${executionId}/kill`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${Buffer.from(billRunEngineConfig.auth).toString("base64")}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw new EngineError("Bill-run engine kill request failed.", {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new EngineError(
        `Bill-run engine returned ${response.status} killing execution ${executionId}.`,
      );
    }
  },
};

export const stubEngineClient: EngineClient = {
  async startExecution(payload: TriggerPayload): Promise<ExecutionRef> {
    logger.info("bill-run engine: stub startExecution", {
      billRunId: payload.bill_run_id,
      banCount: payload.ban_ids.length,
      attempt: payload.attempt,
    });
    return {
      executionId: `stub-exec-${payload.bill_run_id}`,
      definitionId: `${ENGINE_NAMESPACE}.${ENGINE_DEFINITION}`,
      definitionRevision: 0,
    };
  },

  // bm12-spec §Design/§Implementation §2. The stub returns a synthetic
  // RUNNING status with no HTTP call — "Check status" against a stub-engine
  // run always sees the execution as alive; a stalled stub run can only be
  // resolved via Cancel.
  async getExecutionStatus(executionId: string): Promise<ExecutionStatus> {
    logger.info("bill-run engine: stub getExecutionStatus", { executionId });
    return { state: "RUNNING" };
  },

  async killExecution(executionId: string): Promise<void> {
    logger.info("bill-run engine: stub killExecution", { executionId });
  },
};

export function getEngineClient(): EngineClient {
  return isBillRunEngineConfigured ? realEngineClient : stubEngineClient;
}
