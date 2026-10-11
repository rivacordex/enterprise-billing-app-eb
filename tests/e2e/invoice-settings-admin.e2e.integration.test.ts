import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { BlobServiceClient } from "@azure/storage-blob";
import { hashPassword } from "better-auth/crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import {
  REPO_ROOT,
  dropAllSchemas,
  freshDatabase,
  purgeInvoiceBlobs,
} from "@/tests/e2e/helpers/fresh-database";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { decodablePng, png, svg } from "@/tests/helpers/logo-fixtures";

// bm63-spec §Design D2 — the admin browser e2e for both Invoice Settings
// screens (overview success criteria 3, 4 and 11), WITHOUT a new dependency:
// the installed `playwright` library (`chromium.launch()`, as the renderer
// does) drives `next start` on a free port against a fresh database built by
// the real setup scripts. Headless, one isolated context per user, and every
// request outside the test server is aborted.
//
// Run with `npm run test:e2e:invoice-settings` (it builds first): this file
// starts the server itself after the database is ready and stops it in
// `afterAll`. It needs a `next build` (`.next/BUILD_ID`), DATABASE_URL,
// BOOTSTRAP_DATABASE_URL and BILLRUN_BLOB_CONNECTION_STRING for the throwaway
// Postgres + Azurite.
//
// Sign-in posts the login page's own CSRF token from inside the page (the
// same double-submit pair the form sends), because the client auth base URL
// is inlined at build time and the server runs on a free port.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;
const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;
const built = existsSync(join(REPO_ROOT, ".next", "BUILD_ID"));

const PASSWORD = "E2e-Invoice-Settings-63!";
const SCRIPT_NAME = "<script>alert(1)</script>";
const SETTINGS = "/administration/invoice-settings";

type Persona = "none" | "reader" | "viewer" | "editor";
const EMAILS: Record<Persona, string> = {
  none: "bm63-none@example.invalid",
  reader: "bm63-reader@example.invalid",
  viewer: "bm63-viewer@example.invalid",
  editor: "bm63-editor@example.invalid",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next start did not answer ${url} within ${timeoutMs} ms`);
}

describe.skipIf(!databaseUrl || !blobConnection || !bootstrapUrl || !built)(
  "bm63 D2 — Invoice Settings admin e2e (next start + playwright)",
  () => {
    let sql: postgresjs.Sql;
    let server: ChildProcess | undefined;
    let browser: Browser;
    let base = "";
    const contexts: BrowserContext[] = [];
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;

    async function createUser(persona: Persona, roleId: string | null) {
      const userId = randomUUID();
      await sql`
        INSERT INTO core.appuser
          (user_id, user_name, user_email, email_verified, auth_method, status,
           force_password_change, failed_login_count)
        VALUES (${userId}, ${`BM63 ${persona}`}, ${EMAILS[persona]}, false,
                'LOCAL', 'ACTIVE', false, 0)`;
      await sql`
        INSERT INTO core.account
          (account_id, user_id, provider_id, provider_account_id, password)
        VALUES (${randomUUID()}, ${userId}, 'credential', ${userId},
                ${await hashPassword(PASSWORD)})`;
      if (roleId) {
        await sql`
          INSERT INTO core.role_assign (ref_user_id, ref_role_id)
          VALUES (${userId}, ${roleId})`;
      }
    }

    async function newRole(name: string, grants: [string, string][]) {
      const [role] = await sql<{ role_id: string }[]>`
        INSERT INTO core.roles (role_name, role_descr)
        VALUES (${name}, 'bm63 e2e') RETURNING role_id`;
      for (const [permission, level] of grants) {
        await sql`
          INSERT INTO core.role_permission_assign
            (ref_role_id, ref_permission_id, permission_type)
          SELECT ${role!.role_id}, permission_id, ${level}
          FROM core.permissions WHERE permission_name = ${permission}`;
      }
      return role!.role_id;
    }

    async function roleId(name: string): Promise<string> {
      const [role] = await sql<{ role_id: string }[]>`
        SELECT role_id FROM core.roles WHERE role_name = ${name}`;
      return role!.role_id;
    }

    // One isolated, headless context per persona, signed in once and reused
    // (Better-Auth rate-limits sign-in); nothing leaves the test server.
    const pages = new Map<Persona, Page>();
    async function signIn(persona: Persona): Promise<Page> {
      const existing = pages.get(persona);
      if (existing) return existing;
      const context = await browser.newContext({ baseURL: base });
      contexts.push(context);
      await context.route("**/*", (route) =>
        route.request().url().startsWith(base) ||
        route.request().url().startsWith("data:") ||
        route.request().url().startsWith("blob:")
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      let status = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        await page.goto("/login");
        status = await page.evaluate(
          async ({ email, password }) => {
            const csrf = (
              document.querySelector('input[name="_csrf"]') as HTMLInputElement
            ).value;
            const res = await fetch("/api/auth/sign-in/email", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-csrf-token": csrf,
              },
              body: JSON.stringify({ email, password }),
            });
            return res.status;
          },
          { email: EMAILS[persona], password: PASSWORD },
        );
        if (status !== 429) break;
        await new Promise((r) => setTimeout(r, 11_000));
      }
      expect(status).toBe(200);
      await page.goto("/");
      await expect.poll(() => page.url()).toBe(`${base}/`);
      pages.set(persona, page);
      return page;
    }

    const dialogs: string[] = [];

    function navLink(page: Page) {
      return page.locator(`aside a[href="${SETTINGS}"]`);
    }

    // Fills the change note and confirms. The dialog resets its note when it
    // opens and when the page refreshes after a save, so the fill and the
    // click retry together until the click lands on an enabled button.
    async function confirmWithNote(
      page: Page,
      note: string,
      confirmName: string,
    ): Promise<void> {
      const dialog = page.getByRole("dialog");
      const textarea = dialog.locator("#activate-change-note");
      const confirm = dialog.getByRole("button", {
        name: confirmName,
        exact: true,
      });
      await textarea.waitFor();
      await expect
        .poll(
          async () => {
            if ((await textarea.inputValue()) !== note) {
              await textarea.fill(note);
            }
            if (!(await confirm.isEnabled())) return false;
            try {
              await confirm.click({ timeout: 2_000 });
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 20_000 },
        )
        .toBe(true)
        .catch(async (err: unknown) => {
          if (process.env.E2E_DEBUG_DIR) {
            await page.screenshot({
              path: `${process.env.E2E_DEBUG_DIR}/confirm-${confirmName}.png`,
              fullPage: true,
            });
          }
          throw err;
        });
    }

    async function previewFrame(page: Page) {
      const frame = page.frameLocator('iframe[title="Invoice preview"]');
      await frame.locator("table").first().waitFor({ timeout: 60_000 });
      return frame;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 3 });
      await freshDatabase(sql, service!);

      // Personas: no invoice_settings; READ without billrun_view; READ with
      // billrun_view (the seeded USER role); EDIT (the seeded MANAGER role).
      await createUser("none", await newRole("BM63 No Settings", []));
      await createUser(
        "reader",
        await newRole("BM63 Settings Reader", [["invoice_settings", "READ"]]),
      );
      await createUser("viewer", await roleId("USER"));
      await createUser("editor", await roleId("MANAGER"));

      // A posted bill whose customer is named `<script>alert(1)</script>`,
      // offered as a preview source to billrun_view holders.
      const { setupInvoiceRenderFixtures } =
        await import("@/tests/db/helpers/invoice-render-fixtures");
      const fx = await setupInvoiceRenderFixtures(sql, "BM63E2E", {
        reset: false,
      });
      await fx.newRun("BRN09063101");
      const { banId } = await fx.postedBill({
        label: "XSS",
        runId: "BRN09063101",
        invoiceNo: "INV09063101",
      });
      await sql`
        UPDATE customer.organization o SET name = ${SCRIPT_NAME}
        FROM billing.billing_account ba
        JOIN customer.party_role pr ON pr.party_role_id = ba.ref_party_role_id
        WHERE ba.billing_account_id = ${banId}
          AND o.organization_id = pr.engaged_party`;

      const port = await freePort();
      base = `http://localhost:${port}`;
      server = spawn(
        process.execPath,
        [
          join(REPO_ROOT, "node_modules/next/dist/bin/next"),
          "start",
          "-p",
          String(port),
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: databaseUrl as string,
            BOOTSTRAP_DATABASE_URL: bootstrapUrl as string,
            BILLRUN_BLOB_CONNECTION_STRING: blobConnection as string,
            BETTER_AUTH_URL: base,
            APP_URL: base,
          },
          stdio: "ignore",
        },
      );
      await waitForServer(`${base}/login`, 120_000);
      browser = await chromium.launch({ headless: true });
    }, 900_000);

    afterAll(async () => {
      for (const c of contexts) await c.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      server?.kill();
      if (service) await purgeInvoiceBlobs(service).catch(() => undefined);
      if (sql) {
        await dropAllSchemas(sql).catch(() => undefined);
        await sql.end();
      }
    }, 120_000);

    it("a user with no invoice_settings sees no nav entry and is sent to /no-access from either page", async () => {
      const page = await signIn("none");
      await expect.poll(() => navLink(page).count()).toBe(0);
      for (const path of ["company-profile", "invoice-template"]) {
        await page.goto(`${SETTINGS}/${path}`);
        await expect.poll(() => page.url()).toBe(`${base}/no-access`);
        await page.getByRole("heading", { name: "No Access" }).waitFor();
      }
    }, 120_000);

    it("a READ user sees both pages read-only; the preview works with the sample only (no billrun_view)", async () => {
      const page = await signIn("reader");
      await navLink(page).waitFor();

      await page.goto(`${SETTINGS}/invoice-template`);
      await page
        .getByRole("heading", { name: /Invoice template v1/ })
        .waitFor();
      expect(await page.getByRole("checkbox").count()).toBe(0);
      expect(
        await page
          .getByRole("button", { name: "Save draft", exact: true })
          .count(),
      ).toBe(0);
      expect(
        await page.getByRole("button", { name: /^Activate/ }).count(),
      ).toBe(0);
      await previewFrame(page);
      await page.locator("#preview-source").click();
      const options = await page.getByRole("option").allTextContents();
      expect(options).toEqual(["Sample bill"]);
      await page.keyboard.press("Escape");

      await page.goto(`${SETTINGS}/company-profile`);
      await page.getByText("No company profile is active.").waitFor();
      expect(await page.locator("form").count()).toBe(0);
      expect(await page.locator('input[type="file"]').count()).toBe(0);
      expect(
        await page
          .getByRole("button", { name: /Save draft|Activate|Create a draft/ })
          .count(),
      ).toBe(0);
    }, 120_000);

    it("a READ user with billrun_view is offered posted bills, and a <script> customer name renders escaped with no dialog (criterion 11)", async () => {
      const page = await signIn("viewer");
      await page.goto(`${SETTINGS}/invoice-template`);
      await previewFrame(page);
      await page.locator("#preview-source").click();
      await page.getByRole("option", { name: /INV09063101/ }).click();
      const frame = page.frameLocator('iframe[title="Invoice preview"]');
      await frame.getByText(SCRIPT_NAME).first().waitFor({ timeout: 60_000 });
      expect(await frame.locator("script").count()).toBe(0);
      expect(dialogs).toEqual([]);
    }, 120_000);

    it("an EDIT user: mandatory sections are locked; hiding Discount removes the column; save → activate (note required) → history and Generated .hbs (criterion 4)", async () => {
      const page = await signIn("editor");
      await page.goto(`${SETTINGS}/invoice-template`);
      expect(await page.locator("#section-billTo").isDisabled()).toBe(true);
      await page.getByTestId("section-billTo").getByText("Required").waitFor();

      const frame = await previewFrame(page);
      await frame.locator('th:text-is("Discount")').first().waitFor();
      await page.locator("#column-showDiscountColumn").click();
      await expect
        .poll(() => frame.locator('th:text-is("Discount")').count(), {
          timeout: 30_000,
        })
        .toBe(0);

      // v2: Discount hidden.
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.getByText("Draft v2 saved — not used on invoices").waitFor();
      await page
        .getByRole("button", { name: "Activate v2", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const confirm = dialog.getByRole("button", {
        name: "Activate v2",
        exact: true,
      });
      // The UI never sends an empty note: confirm stays disabled for an empty
      // or whitespace-only note (React ignores clicks on a disabled button,
      // so the server's CHANGE_NOTE_REQUIRED is proven at the action layer,
      // tests/actions/billing/invoice-settings/activate-template.action.test.ts).
      await dialog.locator("#activate-change-note").waitFor();
      expect(await confirm.isDisabled()).toBe(true);
      await dialog.locator("#activate-change-note").fill("   ");
      expect(await confirm.isDisabled()).toBe(true);
      await confirmWithNote(page, "e2e: hide discount", "Activate v2");
      await page.getByText("Template v2 activated").waitFor();

      // v3: Notes & terms hidden too — v2 becomes RETIRED.
      await page.goto(`${SETTINGS}/invoice-template`);
      await page.locator("#section-notes").click();
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.getByText("Draft v3 saved — not used on invoices").waitFor();
      await page
        .getByRole("button", { name: "Activate v3", exact: true })
        .click();
      await confirmWithNote(page, "e2e: hide notes", "Activate v3");
      await page.getByText("Template v3 activated").waitFor();

      await page.goto(`${SETTINGS}/invoice-template?tab=history`);
      // The version cell reads "v{n}" followed by the version id.
      const row = (n: number) =>
        page
          .locator("tbody tr")
          .filter({ hasText: new RegExp(`^\\s*v${n}BTV`) });
      await row(3).locator('[data-status="ACTIVE"]').waitFor();
      await row(2).locator('[data-status="RETIRED"]').waitFor();
      await row(3).getByText("e2e: hide notes").waitFor();

      await page.goto(`${SETTINGS}/invoice-template?tab=generated`);
      const hbs = await page
        .locator('pre[aria-label="invoice.hbs"]')
        .innerText();
      expect(hbs.length).toBeGreaterThan(1000);
      expect(hbs).not.toContain("[[");
      expect(hbs).not.toContain("sec--notes");
      expect(hbs).not.toMatch(/<th[^>]*>Discount<\/th>/);
    }, 300_000);

    it("an EDIT user: invalid profile fields are rejected inline, bad logos are rejected, activation needs a logo, then succeeds with the bank warning (criterion 3)", async () => {
      const page = await signIn("editor");
      await page.goto(`${SETTINGS}/company-profile`);
      const create = page.getByRole("button", { name: "Create a draft" });
      if (await create.count()) await create.click();
      await page.locator("#profile-company_name").waitFor();

      const fill = (key: string, value: string) =>
        page.locator(`#profile-${key}`).fill(value);
      await fill("company_name", "E2E Billing Sdn Bhd");
      await fill("tin", "123");
      await fill("sst_reg_no", "bad");
      await fill("postcode", "12");
      await fill("swift", "x");
      await fill("email", "not-an-email");
      await fill("brand_color", "red");
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      for (const message of [
        "TIN is 1–2 letters then 10–11 digits, e.g. C12345678901",
        "SST no. looks like W10-1808-31000001",
        "Postcode is 5 digits",
        "SWIFT is 8 or 11 characters, e.g. MBBEMYKL",
        "Enter a valid email address",
        "Use a #RRGGBB colour, e.g. #2E45A9",
      ]) {
        await page.getByText(message).first().waitFor();
      }

      for (const [key, value] of Object.entries({
        registration_no: "202001000063",
        tin: "C12345678901",
        sst_reg_no: "",
        address_line1: "Level 63, Menara E2E",
        postcode: "50450",
        city: "Kuala Lumpur",
        phone: "+60 3-2000 0063",
        email: "billing@e2e.example",
        brand_color: "#2E45A9",
        accent_color: "#006975",
        bank_name: "Maybank Berhad",
        bank_account_name: "E2E Billing Sdn Bhd",
        bank_account_no: "5140-1234-5678",
        swift: "MBBEMYKL",
        remittance_email: "ar@e2e.example",
        payment_terms_days: "30",
      })) {
        await fill(key, value);
      }
      await page.locator("#profile-state_code").click();
      await page.getByRole("option", { name: /^14 / }).click();
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page.getByText(/Draft profile v1 saved/).waitFor();

      // Activation without a logo is refused.
      await page
        .getByRole("button", { name: "Activate v1", exact: true })
        .click();
      await confirmWithNote(page, "e2e: first profile", "Activate v1");
      await page
        .getByRole("dialog")
        .getByText("Upload a logo before activating the profile.")
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel" })
        .click();

      // Logo rejections (each leaves the draft unchanged).
      const upload = async (name: string, mimeType: string, buffer: Buffer) => {
        await page
          .locator("#profile-logo-file")
          .setInputFiles({ name, mimeType, buffer });
      };
      const alert = page
        .getByTestId("logo-dropzone")
        .locator("..")
        .getByRole("alert");
      await upload("big.png", "image/png", png(400, 400, 600_000));
      await expect.poll(() => alert.innerText()).toMatch(/the limit is 500 KB/);
      await upload("small.png", "image/png", decodablePng(200, 200));
      await expect
        .poll(() => alert.innerText())
        .toMatch(/the shorter side must be at least 300 px/);
      await upload("fake.svg", "image/svg+xml", decodablePng(320, 320));
      await expect
        .poll(() => alert.innerText())
        .toMatch(/not a valid PNG, JPEG or SVG/);
      await upload(
        "evil.svg",
        "image/svg+xml",
        Buffer.from(
          svg('width="400" height="400"', "<script>alert(1)</script>"),
        ),
      );
      await expect.poll(() => alert.innerText()).toMatch(/The SVG contains/);
      expect(dialogs).toEqual([]);

      // A valid logo, then activation with the bank-change warning.
      await upload("logo.png", "image/png", decodablePng(320, 320, 0x40));
      await page.getByText(/Logo v1 added to draft v1/).waitFor();
      await page
        .getByRole("button", { name: "Activate v1", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("note")
        .getByText(/Bank details change on every new invoice/)
        .waitFor();
      await confirmWithNote(page, "e2e: first profile", "Activate v1");
      await page.getByText("Company profile v1 activated").waitFor();
    }, 300_000);
  },
);
