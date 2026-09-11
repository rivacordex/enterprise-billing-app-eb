import { logger } from "@/lib/logger";

// bm03-spec §Design/Implementation §5, revised bm16-spec §Implementation §1
// (D24). The outbound workflow engine is **treated as not-yet-deployed**
// (project decision) — a mockable client so the trigger transaction is fully
// testable with no live engine. Framework-agnostic (no `next/*`), reads NO
// config of its own: `startExecution`/`getExecutionStatus`/`killExecution`
// take a resolved `EngineConnection`, never a hard-coded URL. The sole caller
// is `services/billing/engine-registry.ts`, which resolves a logical engine
// name ("billrun") to a connection + a stable identity string and selects the
// real vs. stub implementation.

// The bare connection details for one physical engine instance — resolved by
// `engine-registry.ts` from config/Key Vault, never read from `process.env`
// here.
export interface EngineConnection {
  baseUrl: string;
  basicAuth: string;
  namespace: string;
}

export interface ProcessingTriggerPayload {
  bill_run_id: string;
  period_start: string;
  period_end: string;
  ban_ids: string[];
  attempt: number;
  gl_event_at: string;
}

// bm20-spec §Implementation §2/§3. The distribution execution's trigger
// payload — transport-only references to already-stored artifacts (bm19)
// plus the target list (D20's forceable-failure loopback). `attempt` mirrors
// `ProcessingTriggerPayload`'s field (a resolved addition to the spec's
// literal §2 input list — the flow template echoes it back on every outcome
// POST so the app can reject a stale round, T1's stale-attempt guard applied
// to distribution).
export interface DistributionArtifactInput {
  ref: string;
  type: "invoice_pdf" | "report_csv";
  blob_ref: string;
}

export interface DistributionTargetInput {
  name: string;
  is_mandatory: boolean;
  force_fail: boolean;
}

export interface DistributionTriggerPayload {
  bill_run_id: string;
  artifacts: DistributionArtifactInput[];
  targets: DistributionTargetInput[];
  attempt: number;
}

export type TriggerPayload =
  | ProcessingTriggerPayload
  | DistributionTriggerPayload;

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
  startExecution(
    connection: EngineConnection,
    flowId: string,
    payload: TriggerPayload,
  ): Promise<ExecutionRef>;
  getExecutionStatus(
    connection: EngineConnection,
    executionId: string,
  ): Promise<ExecutionStatus>;
  killExecution(
    connection: EngineConnection,
    executionId: string,
  ): Promise<void>;
}

export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
  }
}

// bm16-spec §Implementation §3, extended bm20-spec §Implementation §2. The
// two deployed (placeholder) flows' ids — the template contracts' `id:
// bill_run_processing` / `id: bill_run_distribution` — under the resolved
// engine's namespace. `engineRegistry.trigger` threads the caller's choice of
// flow id through to `startExecution`; this file hardcodes neither.
export const PROCESSING_FLOW_ID = "bill_run_processing";
export const DISTRIBUTION_FLOW_ID = "bill_run_distribution";
const REQUEST_TIMEOUT_MS = 15_000;

// Kestra's Execution response shape (v1.3.x). The trigger endpoint returns the
// created Execution: `id` is the execution id (NOT `executionId`), `flowRevision`
// the deployed flow revision, `state.current` the lifecycle state. Legacy
// `executionId`/`definitionRevision` are kept as fallbacks so the stub's
// synthetic shape still parses.
interface RawExecutionResponse {
  id?: string;
  executionId?: string;
  namespace?: string;
  flowId?: string;
  flowRevision?: number;
  definitionId?: string;
  definitionRevision?: number;
}

function authHeader(basicAuth: string): string {
  return `Basic ${Buffer.from(basicAuth).toString("base64")}`;
}

// Kestra's trigger endpoint consumes multipart/form-data — each flow input is a
// form field. JSON-typed inputs (ban_ids, artifacts, targets) go as JSON
// strings; scalars are stringified. `fetch` sets the multipart Content-Type +
// boundary from the FormData, so Content-Type is deliberately NOT set by hand.
function toFormData(payload: TriggerPayload): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    form.append(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  }
  return form;
}

// Maps Kestra's `state.current` onto the four states the module reasons about.
// Non-terminal states (incl. KILLING mid-cancel) surface as RUNNING; SUCCESS/
// WARNING as SUCCESS; CANCELLED as KILLED. An unmapped state throws (fail loud),
// never silently treated as alive.
const KESTRA_STATE_MAP: Record<string, ExecutionState> = {
  CREATED: "RUNNING",
  QUEUED: "RUNNING",
  RUNNING: "RUNNING",
  PAUSED: "RUNNING",
  RESTARTED: "RUNNING",
  RETRYING: "RUNNING",
  RETRIED: "RUNNING",
  KILLING: "RUNNING",
  SUCCESS: "SUCCESS",
  WARNING: "SUCCESS",
  FAILED: "FAILED",
  KILLED: "KILLED",
  CANCELLED: "KILLED",
};

export const realEngineClient: EngineClient = {
  async startExecution(
    connection: EngineConnection,
    flowId: string,
    payload: TriggerPayload,
  ): Promise<ExecutionRef> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${connection.baseUrl}/executions/${connection.namespace}/${flowId}`;

    // Keep the abort timer live across the WHOLE exchange — the fetch, the
    // status check, and the body read — so a response that streams its
    // headers then stalls the body can't hang `response.json()` past the
    // timeout (same shape as `getExecutionStatus` below). Cleared in the
    // finally on every path (success and each throw below).
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: authHeader(connection.basicAuth),
          },
          body: toFormData(payload),
          signal: controller.signal,
          // Never auto-follow a redirect — the engine URL is required to be
          // HTTPS (lib/config.ts), and a followed redirect could downgrade to
          // plain HTTP and resend the Basic-Auth header in the clear. A 3xx
          // response surfaces here as a non-ok "opaqueredirect" and is
          // rejected by the `!response.ok` check below like any other
          // failure.
          redirect: "manual",
        });
      } catch (err) {
        throw new EngineError("Bill-run engine request failed.", {
          cause: err,
        });
      }

      if (!response.ok) {
        throw new EngineError(
          `Bill-run engine returned ${response.status} for run ${payload.bill_run_id}.`,
        );
      }

      let body: RawExecutionResponse;
      try {
        body = (await response.json()) as RawExecutionResponse;
      } catch (err) {
        throw new EngineError(
          `Bill-run engine returned an unparseable body for run ${payload.bill_run_id}.`,
          { cause: err },
        );
      }
      const executionId = body.id ?? body.executionId;
      if (!executionId) {
        throw new EngineError(
          `Bill-run engine response for run ${payload.bill_run_id} is missing executionId.`,
        );
      }

      return {
        executionId,
        definitionId:
          body.namespace && body.flowId
            ? `${body.namespace}.${body.flowId}`
            : (body.definitionId ?? `${connection.namespace}.${flowId}`),
        definitionRevision: body.flowRevision ?? body.definitionRevision ?? 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  },

  // bm12-spec §Design/§Implementation §2. Endpoint paths (`/executions/{id}`
  // GET, `/executions/{id}/kill` DELETE) and the `state.current` response shape
  // verified against Kestra v1.3.35 (local dev). Still subject to whatever the
  // separate workflow-management repo's engine ultimately deploys.
  async getExecutionStatus(
    connection: EngineConnection,
    executionId: string,
  ): Promise<ExecutionStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${connection.baseUrl}/executions/${executionId}`;

    // Keep the abort timer live across the WHOLE exchange — the fetch, the
    // status check, and the body read — so a response that streams its headers
    // then stalls the body can't hang `response.json()` past the timeout.
    // Cleared in the finally on every path (success and each throw below).
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Authorization: authHeader(connection.basicAuth) },
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        throw new EngineError("Bill-run engine status request failed.", {
          cause: err,
        });
      }

      if (!response.ok) {
        throw new EngineError(
          `Bill-run engine returned ${response.status} for execution ${executionId} status.`,
        );
      }

      let body: { state?: { current?: string } };
      try {
        body = (await response.json()) as { state?: { current?: string } };
      } catch (err) {
        // A 2xx with a malformed body still breaks the client's contract — wrap
        // it as an EngineError like every other failure rather than leaking a raw
        // SyntaxError to the caller.
        throw new EngineError(
          `Bill-run engine returned an unparseable body for execution ${executionId} status.`,
          { cause: err },
        );
      }
      const current = body.state?.current;
      const mapped = current ? KESTRA_STATE_MAP[current] : undefined;
      if (!mapped) {
        throw new EngineError(
          `Bill-run engine returned an unrecognized state for execution ${executionId}.`,
        );
      }

      return { state: mapped };
    } finally {
      clearTimeout(timeout);
    }
  },

  // bm12-spec §Design/§Implementation §2. Same "verify against the deployed
  // engine version" flag as `getExecutionStatus` above.
  async killExecution(
    connection: EngineConnection,
    executionId: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${connection.baseUrl}/executions/${executionId}/kill`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: authHeader(connection.basicAuth) },
        signal: controller.signal,
        redirect: "manual",
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
  async startExecution(
    _connection: EngineConnection,
    flowId: string,
    payload: TriggerPayload,
  ): Promise<ExecutionRef> {
    logger.info("bill-run engine: stub startExecution", {
      flowId,
      billRunId: payload.bill_run_id,
      attempt: payload.attempt,
    });
    return {
      executionId: `stub-exec-${flowId}-${payload.bill_run_id}`,
      definitionId: `${_connection.namespace}.${flowId}`,
      definitionRevision: 0,
    };
  },

  // bm12-spec §Design/§Implementation §2. The stub returns a synthetic
  // RUNNING status with no HTTP call — "Check status" against a stub-engine
  // run always sees the execution as alive; a stalled stub run can only be
  // resolved via Cancel.
  async getExecutionStatus(
    _connection: EngineConnection,
    executionId: string,
  ): Promise<ExecutionStatus> {
    logger.info("bill-run engine: stub getExecutionStatus", { executionId });
    return { state: "RUNNING" };
  },

  async killExecution(
    _connection: EngineConnection,
    executionId: string,
  ): Promise<void> {
    logger.info("bill-run engine: stub killExecution", { executionId });
  },
};
