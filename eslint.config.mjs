import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";
import prettierConfig from "eslint-config-prettier";

// Layer ownership and the inward-only dependency rule (um01-spec §3.3, architecture §2).
// `tests/` and `infra/` are deliberately not declared as elements: they sit outside the
// layered import graph and may import any layer.
const BOUNDARIES_ELEMENTS = [
  // Carved out ahead of the general "app" pattern (um06-spec §6.8): the
  // root redirect intentionally bypasses `requirePermission`/
  // `requireAuthenticated` (reusing the guard here risks a redirect loop
  // when `force_password_change` is true), so it needs the same direct
  // repository access the guard would otherwise provide.
  { type: "root-page", mode: "full", pattern: "app/page.tsx" },
  { type: "app", mode: "full", pattern: "app/**" },
  { type: "actions", mode: "full", pattern: "actions/**" },
  { type: "services", mode: "full", pattern: "services/**" },
  { type: "validation", mode: "full", pattern: "validation/**" },
  // Carved out ahead of the general "auth" pattern (um03-spec §3.8): only
  // this client-safe entry point may be imported by `components/**`. The
  // server config in auth/index.ts (and any other auth/** file) must stay
  // out of the client bundle (Inv. #2, code-standards §3.10).
  { type: "auth-client", mode: "full", pattern: "auth/client.ts" },
  // Carved out ahead of the general "auth" pattern (um07-spec §7.8):
  // `UserTable` needs the typed `PERMISSIONS`/`LEVELS` constants to
  // show/hide its "Add User" button — a leaf module with no DB/Next.js
  // imports, safe for the client bundle (unlike auth/index.ts).
  {
    type: "auth-permission-constants",
    mode: "full",
    pattern: "auth/permission-constants.ts",
  },
  { type: "auth", mode: "full", pattern: "auth/**" },
  { type: "db", mode: "full", pattern: "db/**" },
  { type: "components", mode: "full", pattern: "components/**" },
  { type: "types", mode: "full", pattern: "types/**" },
  { type: "lib", mode: "full", pattern: "lib/**" },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
      "boundaries/elements": BOUNDARIES_ELEMENTS,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
      // Deny-by-default inward-only import graph (um01-spec §3.3).
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            {
              from: { type: "root-page" },
              allow: {
                to: {
                  type: [
                    "root-page",
                    "auth",
                    "auth-permission-constants",
                    "db",
                    "components",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              // "app" is included so route segment files can share same-folder
              // imports (e.g. layout.tsx/error.tsx importing ./globals.css).
              from: { type: "app" },
              allow: {
                to: {
                  type: [
                    "app",
                    "actions",
                    "services",
                    "auth",
                    "auth-permission-constants",
                    "components",
                    "validation",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              // "auth-permission-constants" added for um08's
              // `create-user.action.ts`, which needs the typed
              // `PERMISSIONS`/`LEVELS` constants for `requirePermission` —
              // same carve-out `components` already uses (um07-spec §7.8).
              from: { type: "actions" },
              allow: {
                to: {
                  type: [
                    "services",
                    "auth",
                    "auth-permission-constants",
                    "validation",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              // "validation" added for um08's `users-write.service.ts`,
              // whose `createUser` signature takes the already-parsed
              // `CreateUserInput` (the action validates before calling the
              // service) — a type-only coupling to the schema's inferred
              // shape, not a runtime Zod dependency.
              from: { type: "services" },
              allow: { to: { type: ["db", "validation", "types", "lib"] } },
            },
            {
              // "auth" self-import added for um04's `auth/lockout.ts` — the
              // pure lock-decision helper imported by `auth/index.ts`'s hook.
              from: { type: "auth" },
              allow: {
                to: {
                  type: [
                    "auth",
                    "auth-permission-constants",
                    "db",
                    "services",
                    "validation",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              from: { type: "auth-permission-constants" },
              allow: { to: { type: ["types"] } },
            },
            {
              from: { type: "db" },
              allow: { to: { type: ["db", "types", "lib"] } },
            },
            {
              from: { type: "validation" },
              allow: { to: { type: ["types"] } },
            },
            {
              // "validation" and "auth-client" added for um03's LoginForm:
              // the RHF resolver schema (code-standards §4.12) and the
              // client-safe Better-Auth instance (um03-spec §3.8).
              // "auth-permission-constants" added for um07's `UserTable`
              // (the typed `PERMISSIONS`/`LEVELS` constants). "actions"
              // added for um08's `CreateUserDialog`, which calls
              // `createUserAction` directly — Server Actions are the public
              // mutation endpoint a Client Component is meant to call
              // (architecture §2 "UI → actions/routes → services").
              from: { type: "components" },
              allow: {
                to: {
                  type: [
                    "components",
                    "validation",
                    "auth-client",
                    "auth-permission-constants",
                    "actions",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              // "db" is allowed here for type-only re-exports of
              // Drizzle-derived row types (um02-spec §3.7, code-standards
              // §2.7) — `types/` never imports db at runtime.
              from: { type: "types" },
              allow: { to: { type: ["types", "db"] } },
            },
            {
              // "types" added for `lib/root-redirect.ts` (um06-spec §6.10's
              // testability extraction), which needs `EffectivePermissionMap`/
              // `meetsLevel`/`PermissionName` — leaf type-only modules, no
              // runtime coupling.
              from: { type: "lib" },
              allow: { to: { type: ["lib", "types"] } },
            },
          ],
        },
      ],
    },
  },
  // eslint-config-prettier last so formatting concerns belong to Prettier (code-standards §3.9).
  prettierConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
