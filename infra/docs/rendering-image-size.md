# App runtime image — Chromium/Playwright size + base-image change (bm18)

bm18 (`context/billing-management/specs/bm18-rendering-draft-preview.md`)
bakes Playwright's Chromium into the deployed app image so `services/billing/
render-invoice.ts` can render the draft PRO-FORMA PDF in-process — the
platform's first in-app document rendering. This is the accepted-risk note
the spec's Implementation §1 calls for (Design "Playwright, in-app, Chromium
baked into the image (D16/D17) ... a real infra change now").

## Base image: `node:22-alpine` → `node:22-bookworm-slim`

All three `Dockerfile` stages (`deps`, `builder`, `runner`) moved from Alpine
to Debian slim for this unit. Resolved ambiguity — the spec's Implementation
§1 says only "install Chromium + its OS deps for Playwright (`npx playwright
install --with-deps chromium`)", which assumes a Debian/Ubuntu base:

- Playwright's bundled Chromium build links against **glibc**; Alpine ships
  **musl libc**, which Playwright does not support as an install target.
- `--with-deps` shells out to `apt-get install`, which doesn't exist on
  Alpine (`apk` is a different package manager with a different repo of OS
  library names) — the documented command would simply fail on the prior
  base image.
- `deps` and `builder` moved to the same base as `runner`, not just `runner`
  alone: the `runner` stage's `COPY --from=deps ... node_modules` overlay
  (better-auth/drizzle-kit's native optionalDependencies binaries included)
  must be built against the same libc it will run under, or a native addon
  silently breaks at runtime. Keeping `deps`/`builder` on Alpine while
  switching only `runner` to Debian would have reintroduced exactly the kind
  of libc mismatch the existing `deps`-stage comment already warns about.

Considered and rejected: installing a system Chromium via `apk add chromium`
and pointing Playwright at it with `executablePath` (a common Alpine
workaround). Rejected because it means tracking Alpine's own Chromium
package version drifting independently of the pinned `playwright` npm
version — the opposite of the spec's "pin the Playwright version (lockfile)
so the browser build is reproducible" requirement.

## Image size

Chromium plus its OS-level dependencies (fonts, X11/graphics libraries,
codecs) adds a substantial amount to the final `runner` image — on the order
of several hundred MB, roughly doubling (or more) the image's prior size on
top of the Alpine → Debian slim base-image switch itself (Debian slim is
already larger than Alpine before Chromium is added). **Accepted** per the
spec ("Note the image-size increase ... accepted, since rendering is
genuinely in scope") — no image-size budget or CI gate exists in this repo to
violate. Container Apps revision pulls will take measurably longer; not
addressed further here.

## `PLAYWRIGHT_BROWSERS_PATH`

Pinned to `/ms-playwright` (an `ENV` set before the install step) rather than
left at Playwright's default (the invoking user's home directory cache). The
install runs as `root` (before `USER nextjs` is set) because `--with-deps`
needs `apt-get`; without a fixed, known path the browser would land under
`/root/.cache/ms-playwright`, unreadable by the non-root `nextjs` user the
container actually runs as. The Dockerfile `chown -R nextjs:nodejs
/ms-playwright` step after install is what makes the browser reachable at
runtime.

## Local dev — Docker Compose vs. bare `npm run dev`

`docker-compose.dev.yml`'s dev stack still runs on plain `node:22-alpine`
(hot-reload dev, not the deployed image) and was **not** switched to
`bookworm-slim` for this unit — see the comment at the top of that file.
Draft PRO-FORMA preview will fail there with a missing-browser error;
tracked in `billmgmt-progress-tracker.md`'s Outstanding section as an
environmental gap, same category as the migrations never applied against a
reachable Postgres. For a bare host `npm run dev` (no Docker), run
`npx playwright install chromium` once first — the host OS supplies whatever
libc it already has, so no container base-image concern applies there.

## Verification

The container-build claim in bm18's checklist ("the app runtime image builds
with Chromium; `renderDraftInvoice` produces a valid PDF in a container built
from the Dockerfile — not only on a dev machine with a system Chromium") is
statically reviewed only in this session — no container runtime was
available to actually build and run the image end-to-end. Build and exercise
`docker build .` plus a draft-invoice request against the resulting image
before treating this unit as fully proven, same environmental caveat as every
DB-gated item in Outstanding.
