import { billRunEngineConfig } from "@/lib/config";
import {
  EngineError,
  realEngineClient,
  stubEngineClient,
} from "@/services/billing/engine-client";
import type {
  EngineClient,
  EngineConnection,
  ExecutionRef,
  ExecutionStatus,
  TriggerPayload,
} from "@/services/billing/engine-client";

// bm16-spec §Design "The engine is addressed by name (D24)" / §Implementation
// §1. `engine-registry.ts` wraps `engine-client.ts` and resolves a LOGICAL
// engine name ("billrun") to a physical connection (base URL, namespace,
// credentials) plus a STABLE engine-identity string, stamped on the run per
// execution (D25e) so a later topology change (one shared Kestra instance vs.
// two) never orphans reconcile/cancel of a historical execution. This is the
// ONLY module that reads `billRunEngineConfig`/calls `engine-client.ts` —
// `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` call the exported
// `engineRegistry` methods below, never the client directly (code-standards
// §7).

// Only one logical engine exists this unit — `distribution_engine_ref`
// (bm20) will extend this union when the distribution engine lands; adding a
// name here is the ONLY app-code change a new logical engine needs (D25).
export type EngineName = "billrun";

interface EngineRawConfig {
  url: string | null;
  auth: string | null;
  namespace: string;
}

// Read fresh on every call (never cached at module scope) — `billRunEngineConfig`
// is a frozen `lib/config.ts` accessor in production, but reading it lazily
// here (rather than eagerly at import time) keeps this module side-effect-free
// to import and mock-friendly in tests.
function rawConfigFor(name: EngineName): EngineRawConfig {
  const configs: Record<EngineName, EngineRawConfig> = {
    billrun: {
      url: billRunEngineConfig.url,
      auth: billRunEngineConfig.auth,
      namespace: billRunEngineConfig.namespace,
    },
  };
  return configs[name];
}

export interface ResolvedEngine {
  name: EngineName;
  connection: EngineConnection;
  // "billrun@<host>/<namespace>" when configured, else a deterministic
  // "billrun@stub/<namespace>" identity — always non-empty so a run always
  // has SOME engine-ref provenance, even under the stub client.
  engineRef: string;
  configured: boolean;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// Exported for direct unit testing — pure, no I/O. Always returns a resolved
// shape (never null): an unconfigured engine still resolves to a usable stub
// connection + a stable stub identity string.
export function resolveEngine(name: EngineName): ResolvedEngine {
  const cfg = rawConfigFor(name);
  const configured = !!cfg.url && !!cfg.auth;
  return {
    name,
    connection: {
      baseUrl: cfg.url ?? `stub://${name}`,
      basicAuth: cfg.auth ?? "",
      namespace: cfg.namespace,
    },
    engineRef: configured
      ? `${name}@${hostOf(cfg.url as string)}/${cfg.namespace}`
      : `${name}@stub/${cfg.namespace}`,
    configured,
  };
}

export function isEngineConfigured(name: EngineName): boolean {
  return resolveEngine(name).configured;
}

function clientFor(resolved: ResolvedEngine): EngineClient {
  return resolved.configured ? realEngineClient : stubEngineClient;
}

export const engineRegistry = {
  // Triggers the named engine and returns the execution ref PLUS the resolved
  // engine's stable identity — the caller stamps `engineRef` onto the run
  // alongside the execution id/flow id/flow revision.
  async trigger(
    name: EngineName,
    payload: TriggerPayload,
  ): Promise<ExecutionRef & { engineRef: string }> {
    const resolved = resolveEngine(name);
    const ref = await clientFor(resolved).startExecution(
      resolved.connection,
      payload,
    );
    return { ...ref, engineRef: resolved.engineRef };
  },

  // `expectedEngineRef` is the run's persisted `processingEngineRef` (D25e) —
  // the identity of the engine the execution actually started against. A
  // topology change (redeploy pointing `billrun` at a different physical
  // instance) would otherwise make `resolveEngine` silently return today's
  // connection and query/kill an unrelated executionId there. Passing it
  // fails loud (ENGINE_UNREACHABLE / logged-and-skipped, per caller) instead
  // of misattributing status or killing the wrong engine's execution.
  async getExecutionStatus(
    name: EngineName,
    executionId: string,
    expectedEngineRef?: string | null,
  ): Promise<ExecutionStatus> {
    const resolved = resolveEngine(name);
    assertEngineRefMatch(resolved, expectedEngineRef);
    return clientFor(resolved).getExecutionStatus(
      resolved.connection,
      executionId,
    );
  },

  async killExecution(
    name: EngineName,
    executionId: string,
    expectedEngineRef?: string | null,
  ): Promise<void> {
    const resolved = resolveEngine(name);
    assertEngineRefMatch(resolved, expectedEngineRef);
    await clientFor(resolved).killExecution(resolved.connection, executionId);
  },
};

function assertEngineRefMatch(
  resolved: ResolvedEngine,
  expectedEngineRef?: string | null,
): void {
  if (expectedEngineRef && expectedEngineRef !== resolved.engineRef) {
    throw new EngineError(
      `Bill-run engine topology mismatch: execution was started against "${expectedEngineRef}" but "${resolved.name}" now resolves to "${resolved.engineRef}".`,
    );
  }
}
