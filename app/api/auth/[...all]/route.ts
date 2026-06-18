import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/auth";

// Mounts Better-Auth's handler only — config and hooks live in auth/index.ts
// (code-standards §5.2).
export const { GET, POST } = toNextJsHandler(auth);

export const dynamic = "force-dynamic";
