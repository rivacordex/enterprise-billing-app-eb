import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

// The static-source guardrails' file walker (bm75 guardrail 74, bm78
// guardrail 68): every .js/.jsx/.ts/.tsx file, incl. the .mjs/.cjs/.mts/.cts
// variants, under `dir` (relative to
// the repo root), as POSIX paths relative to it; node_modules is skipped and a
// missing dir yields nothing.
export function listSourceFiles(dir: string): string[] {
  const root = process.cwd();
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules") continue;
      const child = resolve(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
        out.push(relative(root, child).split(sep).join("/"));
      }
    }
  };
  const abs = resolve(root, dir);
  if (existsSync(abs)) walk(abs);
  return out;
}
