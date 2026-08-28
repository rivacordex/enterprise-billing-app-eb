# rating-engine access — Entra Easy Auth provisioning & risk sign-off

`rm05-entra-reverse-proxy.md` puts the `rating-engine` Kestra UI behind
Container Apps built-in authentication (Easy Auth) with Entra: exactly one
`Workflow.Admin` app role, assignment required, gated to a Billing Ops
Entra group, reachable only from allow-listed corporate IP ranges, with
sign-in access retained 7 years. This doc is the provisioning order plus
the recorded, signed-off accepted risk (D10) — the counterpart to
`db-role-verification.md` for this unit.

## Provisioning order (once per environment)

Steps 1–2 are Entra admin actions (Portal or `az ad app` / `az ad group`),
**not** Bicep — they create objects this repo's IaC only references by ID,
same treatment as any other Azure AD artifact in this repo.

1. **Entra app registration `rating-engine`** (rm05 D3, Implementation §1):
   - register `rating-engine`, single-tenant, redirect URI
     `https://<engine-fqdn>/.auth/login/aad/callback`;
   - define exactly one app role — no read-only tier (D4):
     ```
     displayName:        "Workflow Admin"
     value:              "Workflow.Admin"
     allowedMemberTypes: ["User"]
     description:        "Full rating-engine (Kestra) operator access."
     ```
   - create a client secret; store its **value** in Key Vault as
     `rating-engine-client-secret` (D8) — never echo it into a file, a
     `.bicepparam`, or anything under `dev/**`;
   - on the enterprise application, set **assignment required = true**
     (D5) — refuses a token to every tenant user not explicitly assigned.
2. **Billing Ops Entra group** (D5, Implementation §2):
   - create the security group (name/object-id TBD at provisioning, e.g.
     `Billing Ops — Rating`);
   - assign its members;
   - assign the **group** (not individuals) to the `Workflow.Admin` app
     role on the `rating-engine` enterprise application. Managing this one
     group is managing engine access — nothing else to touch per person.
3. **Apply `infra/bicep/modules/easy-auth.bicep`** (via `main.bicep`,
   `deployEasyAuth=true`) — requires `deployRatingEngine=true` already
   applied (rm04's Container App must exist; `easyAuth` references its
   output and fails to deploy otherwise):
   - `ratingEngineEntraClientId` = the app id from step 1;
   - `corporateIpAllowList` = the org's corporate CIDR ranges, supplied at
     deploy time (never committed as literals, D6) — **required and
     non-empty**; an empty list fails this deployment rather than shipping
     external ingress with no restriction (verification item 14).
   - This same pass also flips `rating-engine-container-app.bicep`'s
     ingress from internal-only/disabled to external
     (`enableEasyAuthIngress: deployEasyAuth`, D2) and adds the
     `rating-engine-client-secret` Key Vault secret reference (D8) — the
     Key Vault entry from step 1 must already exist, or this deploy fails
     resolving it (verification item 8/14).
   - Sets the Container App diagnostic setting (console + system logs) and
     the Log Analytics table retention (`SigninLogs`,
     `ContainerAppConsoleLogs`, `ContainerAppSystemLogs` → 2555 days /
     archive tier) on the shared workspace (D7).
4. **Entra tenant sign-in log export** (D7, Implementation §5) — a
   **separate, manual** step; see
   `infra/bicep/modules/entra-signin-diagnostics.bicep`'s header for why
   this can't ride in `main.bicep` (tenant scope, tenant-level role, not a
   resource-group Contributor action):
   ```
   az deployment tenant create \
     --name rm05-entra-signin-diagnostics \
     --location <location> \
     --template-file infra/bicep/modules/entra-signin-diagnostics.bicep \
     --parameters logAnalyticsWorkspaceId=<same workspace ID as step 3>
   ```
   Run by whoever holds tenant-level Security Administrator (or better) —
   not necessarily the same operator who ran step 3.

Only after all four steps: a Billing Ops user assigned `Workflow.Admin`
reaches the UI from an allow-listed IP; everyone else is refused, either
at the network edge (D6) or at the Entra assignment check (D5).

### Storage-Account export alternative (D7)

Table-level Log Analytics retention (step 3) is the default path. Teams
that prefer cheaper cold storage instead of/alongside the archive tier can
add a **diagnostic export to a Storage Account** with a 7-year lifecycle
policy on both the Entra sign-in logs and the Container App logs — the
same lifecycle-rule pattern `rating-engine-storage.bicep` already uses for
the `archive` container (rm04 D4). Not built in this pass; documented here
per Implementation §5 as the alternative, not the default.

## Flow deployment — git is the required process, not the UI (rm06 D2)

Every flow change (`rating-engine/flows/**`) is a git commit, deployed by
`infra/azure-pipelines.yml`'s `deploy_rating_flows` stage on merge to
`main`, via the `kestra` CLI (the same pinned image as the worker,
`kestra flow validate` then `kestra flow namespace update rating ./flows`,
authenticated with the `kestra-basic-auth-password` Key Vault secret).
Git-based deployment is the **required process**, not a restriction the
engine enforces: Kestra OSS does **not** technically prevent editing a flow
in the UI — it has no read-only tier and no per-user action history — so a
UI edit would be an untracked change to how money is calculated, invisible
to `git log` and to review (code-standards §3.1). Treating the UI as
read-only is therefore a discipline held by process and by the
accepted-risk mitigations below (sign-in logs correlated with git history),
not by the engine itself. The Billing Ops UI access provisioned above
(steps 1-4) is for **reading** execution state and logs, not for authoring
flows.

**Not yet resolved** (rm06, flagged rather than assumed — see the
`deploy_rating_flows` stage's own header comment in `azure-pipelines.yml`
and `ratemgmt-progress-tracker.md` Open Questions):

- **Network reachability.** Every other stage in this pipeline reaches
  Container Apps through the Azure Resource Manager control plane
  (`az containerapp ...`), never the app's own HTTP endpoint, specifically
  because the ingress may be internal-only (rm04 D8) or IP-allow-listed
  (rm05 D6). `kestra flow namespace update` has no ARM-level equivalent —
  it needs a direct HTTP path to the Kestra webserver from the hosted ADO
  agent, which neither ingress mode obviously provides. Once this proxy is
  deployed (Easy Auth, `unauthenticatedClientAction: RedirectToLoginPage`),
  a non-interactive CLI call would also need to get past the Entra
  redirect, which is not addressed anywhere in this doc or rm05's spec.
- **`kestra` CLI flag names** (`--server`, `--user user:password`) are the
  rm06 spec's literal text, unconfirmed against the pinned `v1.3.35`
  release — the same class of caveat as `kestra.yml`'s D0 property-name
  notes.
- **Key Vault read access for the pipeline's own service principal.** Every
  existing Key Vault role assignment in this repo's Bicep grants a
  Container App's Managed Identity access; none grants the pipeline's
  service connection principal `Key Vault Secrets User`, which
  `deploy_rating_flows` needs to read `kestra-basic-auth-password` directly.

## Deviations from the spec's literal text (recorded, not silent)

- **File location.** The spec names `infra/easy-auth.bicep`. This repo
  already deviated for rm04 (see
  `ratemgmt-progress-tracker.md` → Architecture Decisions,
  2026-08-27) to keep one Bicep module graph under
  `infra/bicep/modules/` rather than a separate rating-repo `infra/`
  tree. Shipped as `infra/bicep/modules/easy-auth.bicep` for the same
  reason.
- **`globalValidation.requireAuthentication`.** The spec's Implementation
  §3 lists `requireAuthentication: true` alongside
  `unauthenticatedClientAction: 'RedirectToLoginPage'`. That property
  belongs to App Service's Easy Auth `GlobalValidation` schema — Container
  Apps' `authConfigs` API (checked against both the 2023-05-01 and
  2024-03-01 type definitions available to `az bicep build`) has no such
  field on this object; the build rejects it. `unauthenticatedClientAction:
  'RedirectToLoginPage'` is the only mechanism this API exposes for the
  same intent, and delivers it: every unauthenticated request is
  redirected to sign-in, never served the UI (verification item 3). See
  `easy-auth.bicep`'s inline comment.

## Accepted risk — signed off (D10)

Anyone who passes the proxy holds **full Kestra instance rights**. Because
rating logic lives in Kestra flow definitions, that means the ability to
**change how money is calculated, in production, with no per-user action
record inside the engine itself** — Kestra OSS has no user model, no
per-action audit trail, no read-only tier (D4's reasoning: a second role
would assert a distinction the engine cannot enforce).

The proxy records **who accessed** the UI (Entra sign-in logs, 7-year
retention — step 3/4 above); it **cannot** record **what they changed**
once inside.

**Mitigations, all required, none sufficient alone:**

- the IP allow-list (D6) — access is impossible from outside the
  corporate network, regardless of Entra state;
- 7-year sign-in logs (D7) — the durable "who and when" record, standing
  in for `core.AUDIT_LOG` (architecture §7 #4);
- flow definitions version-controlled in git (rm06 / Open item 5) — "what
  changed" is answerable only by correlating a sign-in log entry with a
  git commit timestamp/author, never from inside the engine.

**Phase-2 fix (not this unit):** the Kestra **Enterprise** edition adds
scoped, revocable per-flow tokens and a real user model, closing this gap
properly. Not in scope for rm05.

**Sign-off:** this risk is accepted for v1 as scoped above. Record the
approver, date, and any conditions here once obtained —
**outstanding as of this writing**; this unit's Bicep/doc work does not
by itself constitute sign-off, only the recorded mechanism for it.

## Verification

The full checklist lives in `rm05-entra-reverse-proxy.md` → Verification
checklist (14 items). None have been run against a live environment in
this pass — same status as rm04's Bicep (build-hygiene-clean,
`az bicep build` passes on every file listed above, not deployed). See
`ratemgmt-progress-tracker.md` for what remains open.
