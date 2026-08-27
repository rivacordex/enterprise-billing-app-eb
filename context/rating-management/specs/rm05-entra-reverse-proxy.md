# rm05 — Entra reverse proxy (Container Apps Easy Auth) — Spec

- **Unit:** rm05 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase B)
- **Repo:** rating repo · **Boundary:** `infra/**` (identity + network) — chiefly `infra/easy-auth.bicep`
- **Builds:** the Kestra UI behind Container Apps built-in auth (Easy Auth) with Entra, gated to a single **Workflow Admin** app role, reachable only from allow-listed corporate IP ranges, with sign-in access retained **7 years**, and the Entra client secret in Key Vault.
- **Depends on:** rm04 (the `rating-engine` Container App, provisioned with restricted ingress).
- **Sources:** `ratemgmt-architecture.md` §4 (operator-access layer), §7 deviations **#7** (Easy Auth revokes/access model) and **#8** (Entra secret in Key Vault) · `rm00-build-plan.md` Unit rm05 · `_newmodule-rating-engine-plan.md` §10 (access model, accepted risk).

> **Codebase-grounded (verified 2026-08-26).** The app already federates to Entra in the **same tenant** (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `ENTRA_TENANT_ID` in `.env.example`/`lib/config.ts`, better-auth Microsoft provider); the Container Apps Environment already has a **Log Analytics** workspace; `infra/bicep/modules/key-vault.bicep` exists (RBAC, soft-delete, purge protection). `easy-auth.bicep` is named as a rating-repo artifact in `ratemgmt-code-standards.md` §8. There is no existing Easy Auth config to extend — this is the first.

---

## Goal

Put the rating engine's Kestra UI behind **Container Apps Easy Auth with Entra** so that only members of a single **Workflow Admin** app role (assigned to a Billing Ops Entra group) reach it, from allow-listed corporate IP ranges, with every sign-in retained **7 years** — the module's substitute for `core.AUDIT_LOG` and the only record of who triggered a reprocess.

---

## Design

### D1. Easy Auth, not Front Door (decided)

Container Apps **built-in authentication (Easy Auth)** fronts the Kestra UI; Front Door was the alternative and is **not** used — so there is no WAF and no separate origin configuration to build or operate (rm00 rm05). Easy Auth requires **external ingress**, so "restricted to the corporate network" is implemented as an **IP allow-list on the Container App's ingress** (D6), not a private endpoint.

### D2. The rm04 → rm05 ingress handoff

rm04 provisioned `rating-engine` with **ingress disabled or internal-only** (rm04 D8), precisely so the engine UI is never briefly exposed unprotected. rm05 is the **one** unit that turns on **external ingress**, and it does so **only** behind Easy Auth + the IP allow-list. rm05 owns the ingress block from here; rm04 and rm05 must not both write it.

### D3. A separate Entra app registration, same tenant

The engine gets its **own** app registration `rating-engine`, in the **same tenant** as the app (`ENTRA_TENANT_ID`), with its own redirect URI (`https://<engine-fqdn>/.auth/login/aad/callback`) and its own client secret in Key Vault.

- **Why separate, not the app's registration:** independent blast radius and independent secret rotation. The app's login registration and the engine's proxy registration fail and rotate on their own schedules.
- **Identities are still shared.** Both authenticate the **same Entra tenant users** the app already uses; a Billing Ops person signs in with one corporate account for both. The engine authorizes on **Entra assignment** (D4/D5), **never** on the app's `core.APPUSER` table — the engine is a separate deployable and takes no dependency on the app's database or user model. That decoupling is the module's boundary (architecture §4: data access is a grant, operator access is the proxy).
- If you later choose to reuse the app's registration, keep the **app role separate** at minimum; the recommendation stands at separate.

### D4. Exactly one app role — "Workflow Admin"

Kestra OSS has **no user model** — one shared Basic Auth credential, no roles, no read-only, no per-user action history (architecture §4). So the registration defines **exactly one** app role:

```
displayName:        "Workflow Admin"
value:              "Workflow.Admin"
allowedMemberTypes: ["User"]        # covers users and groups when assigned
description:        "Full rating-engine (Kestra) operator access."
```

There is **no read-only tier**, deliberately: a second role would assert a distinction the engine cannot enforce, which is a category error. Holding "Workflow Admin" maps to **full Kestra instance rights** — the accepted risk in D10.

### D5. Assignment required + a Billing Ops group (prerequisite)

- **Prerequisite (does not exist yet):** create a Billing Ops **Entra security group** (e.g. `Billing Ops — Rating`). Name/object-id filled in at provisioning.
- Set **"User assignment required = true"** on the enterprise application, and **assign the Billing Ops group** to the `Workflow.Admin` app role.
- Effect: only assigned identities receive a token; every other authenticated tenant user is **refused at the proxy**. Managing that one group is managing engine access — add/remove a person there, nowhere else.

### D6. IP allow-list on ingress

Easy Auth **authenticates**; the network restriction is a separate layer. The Container App ingress carries **`ipSecurityRestrictions`** allowing the corporate CIDR ranges (a per-environment Bicep parameter — the ranges are org-specific and are not committed as literals), with default-deny once any Allow rule is present. A request from outside the ranges is refused **before** authentication (architecture §4: ingress restricted).

### D7. Sign-in logging, retained 7 years (the load-bearing part)

The authoritative "who accessed the UI / who triggered a reprocess" record is **Entra sign-in logs**. Default retention is **7 days (Entra ID Free) / 30 days (P1 or P2)** — far short of 7 years — and the Log Analytics workspace defaults to **30 days**. So rm05 **explicitly configures** retention:

- **Diagnostic settings** route Entra **sign-in logs** and the Container App's **ingress/console logs** to the **shared Log Analytics workspace**;
- **table-level retention is set to 2555 days (7 years, archive tier)**;
- **alternative** for cheaper cold storage: a **diagnostic export to a Storage Account** with a 7-year lifecycle policy.

These logs are the module's substitute for `core.AUDIT_LOG` (architecture §7 #4) and the only record of who triggered a reprocess; a 30-day default **silently voids** that deviation (rm00 rm05). This is not incidental configuration.

### D8. The client secret is a Key Vault entry, not `.env`

Platform Inv #13 puts the app's Entra secret in `.env`, rotated by redeploy — that is the Next.js **app**, which has a `.env`. rm05 is `infra/**` and has none, and `dev/**` must never hold real credentials. So the engine registration's client secret is a **Key Vault** secret, injected into the Container App as an env-var reference (the app's established pattern), and referenced by the `authConfig`. A scoped, recorded departure from the platform pattern (architecture §7 #8).

### D9. The proxy covers the UI only — no API exclusion path

Kestra OSS serves its **UI and REST API on one origin**. Rating's engine receives **no app-initiated calls** and no rating flow calls back into the app (code-standards §4), so **no `/api/**` exclusion path is needed** — Easy Auth applies to the whole origin. If that ever changes, an Easy Auth policy in front of `/api/**` would break the caller, and the exclusion must be an **explicit, reviewed** change, never a quiet one.

### D10. Accepted risk, signed off

Anyone past the proxy holds **full Kestra instance rights**, which — because rating logic lives in the flow definitions — means the ability to **change how money is calculated, in production, with no per-user record inside the engine**. The proxy records **who accessed** the UI; it cannot record **what they changed**. Mitigations: the IP allow-list (D6), the 7-year sign-in logs (D7), and flow definitions version-controlled in git (rm06 / Open item 5). Phase-2 fix is the Kestra **Enterprise** edition (scoped, revocable per-flow tokens and a real user model). The sign-off is recorded in the provisioning doc (Implementation §7).

---

## Implementation

### 1. Entra app registration (`rating-engine`) — provisioning prerequisite

Created by an Entra admin (Portal or `az ad app`), documented, not in application code:
- register `rating-engine`, single-tenant, redirect URI `https://<engine-fqdn>/.auth/login/aad/callback`;
- define the **`Workflow.Admin`** app role (D4);
- create a **client secret** → store its value in Key Vault (D8); never echo it into a file;
- on the enterprise application, set **assignment required = true**.

### 2. Billing Ops Entra group — provisioning prerequisite

- create the security group (name TBD at provisioning);
- assign its members (the Billing Ops people);
- assign the **group** to the `Workflow.Admin` app role on the enterprise application (D5).

### 3. `infra/easy-auth.bicep` — the auth config

Declares a `Microsoft.App/containerApps/authConfigs@2023-05-01` resource named `current` on the `rating-engine` Container App:
- `platform.enabled: true`;
- `globalValidation.unauthenticatedClientAction: 'RedirectToLoginPage'`, `requireAuthentication: true`;
- `identityProviders.azureActiveDirectory.registration`: `clientId` (the `rating-engine` app id), `openIdIssuer` (`https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0`), `clientSecretSettingName` (the Container App secret name backed by the Key Vault reference from D8);
- `validation.allowedAudiences`: the `rating-engine` app id URI.

### 4. Ingress + IP allow-list — the rm04→rm05 handoff

Update the `rating-engine` Container App ingress (D2): `external: true`, `targetPort` = Kestra UI port, and `ipSecurityRestrictions` = an array of `{ action: 'Allow', ipAddressRange: <corporate CIDR> }` from a **Bicep parameter** (default-deny once populated). This is the only place external ingress is enabled.

### 5. Diagnostic settings + retention (D7)

- a diagnostic setting on the **Entra tenant** exporting `SignInLogs` to the shared Log Analytics workspace;
- a diagnostic setting on the **Container App** exporting ingress/console logs to the same workspace;
- set the relevant tables' retention to **2555 days**;
- document the **Storage-Account export** alternative (7-year lifecycle) for teams that prefer cold archive.

### 6. Key Vault secret reference (D8)

The `rating-engine` client secret is a Key Vault entry; the Container App references it as a secret (Managed Identity, `Key Vault Secrets User`), and `easy-auth.bicep` points `clientSecretSettingName` at it. No secret value in Bicep parameters, `.env` templates, or `dev/**`.

### 7. `infra/docs/engine-access.md` — provisioning order + risk sign-off

Extend the provisioning docs (alongside `db-role-verification.md`) with: the exact order (app registration → Workflow.Admin role → Billing Ops group → assignment-required → client secret to Key Vault → apply `easy-auth.bicep` → enable ingress + IP allow-list → diagnostic settings/retention), and the **recorded, signed-off accepted risk** (D10).

---

## Dependencies (packages to install)

**None.** This unit is infra + Entra administration only — Bicep, the `az` CLI, and an Entra admin creating the app registration, the app role, and the Billing Ops group. No npm or Python packages. The Entra objects are Azure AD artifacts, not code dependencies.

---

## Verification checklist

Run against the deployed environment except where noted.

**Authentication and authorization (D3, D4, D5)**

1. A user in the Billing Ops group (holding `Workflow.Admin`) signs in with their Entra identity and reaches the Kestra UI.
2. An authenticated tenant user **not** assigned `Workflow.Admin` is **refused** (assignment-required is on).
3. An unauthenticated request is redirected to the Entra login (or returns 401), never served the UI.
4. `az ad app` shows the `rating-engine` registration defines **exactly one** app role, `Workflow.Admin`, and no read-only role.
5. The registration is **separate** from the app's login registration (distinct app id), same tenant.

**Network restriction (D6)**

6. A request from an IP **outside** the allow-listed ranges is refused **before** authentication.
7. A request from an allow-listed range proceeds to the Easy Auth challenge.

**Secret handling (D8)**

8. The client secret resolves from **Key Vault** into the Container App; it appears in no `.env` template, no Bicep parameter file, and nothing under `dev/**`.

**Logging and retention (D7)**

9. A sign-in produces an **Entra sign-in log** entry (who, when, source IP, result).
10. The Log Analytics table retention is **2555 days**; a sign-in record is still queryable under that setting. *(assert the retention config; full 7-year proof is a config assertion, not a wait)*

**Boundary and scope (D9, D2)**

11. Easy Auth applies to the whole engine origin; there is **no `/api/**` exclusion path** in the `authConfig`.
12. External ingress is enabled **only** on `rating-engine` and **only** behind Easy Auth (`requireAuthentication: true`); rm04's restricted-ingress default is now superseded exactly once, here.

**Risk record (D10)**

13. `infra/docs/engine-access.md` records the provisioning order and the signed-off accepted risk, including that the engine has no per-user action history and "who changed a flow" is answerable only from git + sign-in logs.

**Build hygiene**

14. `easy-auth.bicep` and the ingress/diagnostic Bicep validate and apply cleanly; a missing Key Vault secret reference or an empty IP allow-list fails the deployment rather than silently exposing the UI.
