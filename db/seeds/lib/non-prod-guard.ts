import { config } from "@/lib/config";

// The hostnames an opt-in seed's connection may target without an explicit
// override — the local dev stand-ins (architecture.md §1, "Local development
// equivalents"). Shared by every opt-in seed's prod guard so the allowlist lives
// in exactly one place: a prod-write guard must never drift between copies.
export const NON_PROD_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "db",
  "postgres",
]);

// Per-seed context for the refusal message, so the shared check stays generic
// while each seed keeps its own recognizable diagnostics — its npm script name,
// its override env var, and a phrase describing the throwaway data it writes.
export interface NonProdGuardContext {
  seedScript: string; // e.g. "db:seed-demo"
  overrideEnv: string; // e.g. "ALLOW_DEMO_SEED"
  action: string; // e.g. `writes opt-in "Demo —" example data`
}

// Refuses a connection string that looks like a production target: its host must
// be a known non-prod stand-in AND NODE_ENV must not be "production". The single
// source of truth for every opt-in seed's prod-write guard. Callers pass the
// label of the URL being checked (e.g. "DATABASE_URL", "BOOTSTRAP_DATABASE_URL")
// so a seed touching more than one connection reports which one was refused.
export function assertNonProductionUrl(
  url: string,
  label: string,
  ctx: NonProdGuardContext,
): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      `${ctx.seedScript} refused: ${label} could not be parsed as a URL.`,
    );
  }

  if (!NON_PROD_HOSTS.has(host) || config.NODE_ENV === "production") {
    throw new Error(
      `${ctx.seedScript} refused: ${label} looks like a production target ` +
        `(host="${host}", NODE_ENV="${config.NODE_ENV}"). This seed ${ctx.action} ` +
        `and must never run against production. Set ${ctx.overrideEnv}=true to ` +
        `override for a deliberate non-local demo box.`,
    );
  }
}
