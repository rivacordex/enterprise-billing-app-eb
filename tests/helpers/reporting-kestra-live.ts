import { createHash } from "node:crypto";

import { expect } from "vitest";

// Shared client for the reporting report flows' live suites (rpt03 onward):
// runs a `reporting` flow on the engine at KESTRA_URL with Basic Auth, and
// reads back its labels, logs (its own and its subflows') and published files.
// The suites are skipped unless the engine's URL and credential are set:
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…

const KESTRA_URL = process.env.KESTRA_URL;
const KESTRA_USER = process.env.KESTRA_BASIC_AUTH_USER;
const KESTRA_PASSWORD = process.env.KESTRA_BASIC_AUTH_PASSWORD;
export const kestraConfigured = Boolean(
  KESTRA_URL && KESTRA_USER && KESTRA_PASSWORD,
);

export interface TaskRun {
  taskId: string;
  state: { current: string };
  outputs?: {
    executionId?: string;
    outputFiles?: Record<string, string>;
    [key: string]: unknown;
  };
}
export interface Execution {
  id: string;
  state: { current: string };
  labels?: { key: string; value: string }[];
  outputs?: Record<string, string>;
  taskRunList?: TaskRun[];
}
interface Log {
  level: string;
  message: string;
}

function authHeader(): string {
  const { protocol, hostname } = new URL(KESTRA_URL!);
  if (
    protocol !== "https:" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    throw new Error(
      `Refusing to send Basic Auth to ${KESTRA_URL} over plain HTTP`,
    );
  }
  return (
    "Basic " +
    Buffer.from(`${KESTRA_USER}:${KESTRA_PASSWORD}`).toString("base64")
  );
}

// A request to the engine's API, whatever its status.
export async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${KESTRA_URL}/api/v1/main${path}`, {
    ...init,
    headers: { Authorization: authHeader(), ...init.headers },
  });
}

// The same, failing on a non-2xx status.
export async function api(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await request(path, init);
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  return res;
}

export function startForm(inputs: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(inputs)) form.append(key, value);
  return form;
}

// Runs reporting/<flowId> to its end.
export async function runFlow(
  flowId: string,
  inputs: Record<string, string>,
): Promise<Execution> {
  const res = await api(`/executions/reporting/${flowId}?wait=true`, {
    method: "POST",
    body: startForm(inputs),
  });
  const { id } = (await res.json()) as Execution;
  // Re-read: the wait=true response can precede the final labels.
  return (await (await api(`/executions/${id}`)).json()) as Execution;
}

// Logs of an execution and of every subflow execution it started.
async function logs(execution: Execution): Promise<Log[]> {
  const own = (await (await api(`/logs/${execution.id}`)).json()) as Log[];
  const children: Log[] = [];
  for (const taskRun of execution.taskRunList ?? []) {
    const childId = taskRun.outputs?.executionId;
    if (childId) {
      const child = (await (
        await api(`/executions/${childId}`)
      ).json()) as Execution;
      children.push(...(await logs(child)));
    }
  }
  return [...own, ...children];
}

export const messages = async (e: Execution, level: string) =>
  (await logs(e)).filter((l) => l.level === level).map((l) => l.message);

export const delivered = async (e: Execution) =>
  (await messages(e, "INFO")).filter((m) => m.startsWith("DELIVERED"));

export const label = (e: Execution, key: string) =>
  e.labels?.find((l) => l.key === key)?.value;

export const ran = (e: Execution, taskId: string) =>
  (e.taskRunList ?? []).some((t) => t.taskId === taskId);

// The published files: the publish task's output files, by name.
export const published = (e: Execution): Record<string, string> =>
  e.taskRunList?.find((t) => t.taskId === "publish")?.outputs?.outputFiles ??
  {};

export async function download(e: Execution, uri: string): Promise<string> {
  return (
    await api(`/executions/${e.id}/file?path=${encodeURIComponent(uri)}`)
  ).text();
}

// A date `days` from today in Asia/Kuala_Lumpur, as YYYYMMDD.
export function klDate(days = 0): string {
  const kl = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000);
  return kl.toISOString().slice(0, 10).replaceAll("-", "");
}

export const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Uploads (or replaces) a file in the `reporting` namespace.
export async function putNamespaceFile(
  path: string,
  content: string,
): Promise<void> {
  const form = new FormData();
  form.append("fileContent", new Blob([content]));
  await api(`/namespaces/reporting/files?path=${encodeURIComponent(path)}`, {
    method: "POST",
    body: form,
  });
}

export async function expectNothingPublished(e: Execution): Promise<void> {
  expect(ran(e, "publish")).toBe(false);
  expect(published(e)).toEqual({});
  expect(await delivered(e)).toEqual([]);
}
