import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm01-spec §3.5 — rename-invariance CI proof for the route-group rename
// (Inv. #12). This suite asserts the invariant by construction rather than
// naming the retired group directly, since a literal reference to it would
// itself trip assertion (c) below.
const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(REPO_ROOT, "app");

const RETIRED_GROUP_NAME = "admin";
const CURRENT_GROUP_NAME = "app";
const retiredGroupSegment = `(${RETIRED_GROUP_NAME})`;
const currentGroupSegment = `(${CURRENT_GROUP_NAME})`;

const ROUTE_MANIFEST = [
  "/",
  "/login",
  "/set-password",
  "/no-access",
  "/administration/users",
  "/administration/roles",
  "/administration/system-config",
  "/administration/audit-log",
  "/products/product-offering",
  "/customers/view",
  "/customers/view/[id]",
] as const;

function collectPageFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const pages: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      pages.push(...collectPageFiles(entryPath));
    } else if (entry.isFile() && entry.name === "page.tsx") {
      pages.push(entryPath);
    }
  }

  return pages;
}

function deriveUrl(pageFilePath: string): string {
  const relative = path.relative(APP_DIR, pageFilePath);
  const segments = relative.split(path.sep);
  segments.pop(); // drop "page.tsx"

  const urlSegments = segments.filter((segment) => !/^\(.+\)$/.test(segment));

  return "/" + urlSegments.join("/");
}

const CODE_DIRECTORIES = [
  "app",
  "actions",
  "auth",
  "components",
  "db",
  "lib",
  "services",
  "types",
  "validation",
  "tests",
];
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".next"]);

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

describe("route-manifest (rename invariance, pm01)", () => {
  it("derives exactly the frozen route manifest from app/**/page.tsx (set-equal, both directions)", () => {
    const pageFiles = collectPageFiles(APP_DIR);
    const derivedUrls = new Set(pageFiles.map(deriveUrl));
    const expectedUrls = new Set<string>(ROUTE_MANIFEST);

    const missing = [...expectedUrls].filter((url) => !derivedUrls.has(url));
    const unplanned = [...derivedUrls].filter((url) => !expectedUrls.has(url));

    expect(missing).toEqual([]);
    expect(unplanned).toEqual([]);
  });

  it("has renamed the route group: the retired group folder is gone, the current one exists", () => {
    const retiredGroupPath = path.join(APP_DIR, retiredGroupSegment);
    const currentGroupPath = path.join(APP_DIR, currentGroupSegment);

    expect(fs.existsSync(retiredGroupPath)).toBe(false);
    expect(fs.existsSync(currentGroupPath)).toBe(true);
  });

  it("leaves no stale reference to the retired route group anywhere in code directories", () => {
    const offendingFiles: string[] = [];

    for (const dirName of CODE_DIRECTORIES) {
      const dirPath = path.join(REPO_ROOT, dirName);
      if (!fs.existsSync(dirPath)) continue;

      for (const filePath of collectSourceFiles(dirPath)) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes(retiredGroupSegment)) {
          offendingFiles.push(path.relative(REPO_ROOT, filePath));
        }
      }
    }

    expect(offendingFiles).toEqual([]);
  });
});
