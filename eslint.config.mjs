import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";
import prettierConfig from "eslint-config-prettier";

// Layer ownership and the inward-only dependency rule (um01-spec §3.3, architecture §2).
// `tests/` and `infra/` are deliberately not declared as elements: they sit outside the
// layered import graph and may import any layer.
const BOUNDARIES_ELEMENTS = [
  { type: "app", mode: "full", pattern: "app/**" },
  { type: "actions", mode: "full", pattern: "actions/**" },
  { type: "services", mode: "full", pattern: "services/**" },
  { type: "validation", mode: "full", pattern: "validation/**" },
  // Carved out ahead of the general "auth" pattern (um03-spec §3.8): only
  // this client-safe entry point may be imported by `components/**`. The
  // server config in auth/index.ts (and any other auth/** file) must stay
  // out of the client bundle (Inv. #2, code-standards §3.10).
  { type: "auth-client", mode: "full", pattern: "auth/client.ts" },
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
                    "components",
                    "validation",
                    "types",
                    "lib",
                  ],
                },
              },
            },
            {
              from: { type: "actions" },
              allow: {
                to: {
                  type: ["services", "auth", "validation", "types", "lib"],
                },
              },
            },
            {
              from: { type: "services" },
              allow: { to: { type: ["db", "types", "lib"] } },
            },
            {
              // "auth" self-import added for um04's `auth/lockout.ts` — the
              // pure lock-decision helper imported by `auth/index.ts`'s hook.
              from: { type: "auth" },
              allow: {
                to: {
                  type: [
                    "auth",
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
              from: { type: "components" },
              allow: {
                to: {
                  type: [
                    "components",
                    "validation",
                    "auth-client",
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
            { from: { type: "lib" }, allow: { to: { type: ["lib"] } } },
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
