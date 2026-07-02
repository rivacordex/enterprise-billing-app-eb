# ZAP PR13 — Security Fix Plan

**Report generated:** 2026-06-30  
**Site scanned:** `ebill-dev-app.agreeablehill-80bee1a6.southeastasia.azurecontainerapps.io`  
**ZAP version:** 2.17.0

**Summary:** 0 High · 3 Medium · 7 Low · 5 Informational

---

## Medium Priority Fixes (must clear before prod promotion)

### 1. Content Security Policy (CSP) Header Not Set

- **ZAP rule:** 10038 | **Instances:** Systemic (all routes)
- **Fix:** Add `Content-Security-Policy` header in Next.js `next.config.js` `headers()` or via middleware.
- **Measurable outcome:** ZAP rule 10038 produces 0 alerts on next scan.
- **Suggested policy starting point:**
  ```
  default-src 'self'; script-src 'self' 'nonce-{nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'
  ```

### 2. Missing Anti-clickjacking Header

- **ZAP rule:** 10020 | **Instances:** 4
- **Fix:** Set `X-Frame-Options: DENY` (or use `frame-ancestors 'none'` in CSP above — fixes both 1 and 2 together).
- **Measurable outcome:** ZAP rule 10020 produces 0 alerts on next scan.

### 3. Absence of Anti-CSRF Tokens

- **ZAP rule:** 10202 | **Instances:** 2 (both on `/login` GET + POST)
- **Fix:** Add a CSRF token to the `/login` form. Since this is Next.js with a server action or API route, use the `next-csrf` package or generate a signed token via `crypto.randomBytes` and store it in a `HttpOnly` cookie, then validate on POST.
- **Measurable outcome:** ZAP rule 10202 produces 0 alerts; the login form renders with a hidden `_csrf` input on every GET and rejects POST requests without a matching token.

---

## Low Priority Fixes

### 4. Strict-Transport-Security (HSTS) Header Not Set

- **ZAP rule:** 10035 | **Instances:** Systemic
- **Fix:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to all responses.
- **Measurable outcome:** ZAP rule 10035 produces 0 alerts; all responses include HSTS with `max-age ≥ 31536000`.

### 5. X-Content-Type-Options Header Missing

- **ZAP rule:** 10021 | **Instances:** Systemic
- **Fix:** Add `X-Content-Type-Options: nosniff` to all responses.
- **Measurable outcome:** ZAP rule 10021 produces 0 alerts.

### 6. Permissions Policy Header Not Set

- **ZAP rule:** 10063 | **Instances:** Systemic
- **Fix:** Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` (expand as needed).
- **Measurable outcome:** ZAP rule 10063 produces 0 alerts.

### 7. Server Leaks Information via `X-Powered-By`

- **ZAP rule:** 10037 | **Instances:** Systemic
- **Fix:** In `next.config.js`, set `poweredByHeader: false`.
- **Measurable outcome:** ZAP rule 10037 produces 0 alerts; no `X-Powered-By` header present in responses.

### 8. Cross-Origin-Embedder-Policy (COEP) Header Missing

- **ZAP rule:** 90004 | **Instances:** 2
- **Fix:** Add `Cross-Origin-Embedder-Policy: require-corp`.
- **Measurable outcome:** ZAP rule 90004 (COEP) produces 0 alerts.

### 9. Cross-Origin-Opener-Policy (COOP) Header Missing

- **ZAP rule:** 90004 | **Instances:** 2
- **Fix:** Add `Cross-Origin-Opener-Policy: same-origin`.
- **Measurable outcome:** ZAP rule 90004 (COOP) produces 0 alerts.

### 10. Cross-Origin-Resource-Policy (CORP) Header Missing

- **ZAP rule:** 90004 | **Instances:** 5
- **Fix:** Add `Cross-Origin-Resource-Policy: same-origin` (use `cross-origin` only for public assets that must be loaded cross-origin).
- **Measurable outcome:** ZAP rule 90004 (CORP) produces 0 alerts.

---

## Implementation Note — Headers in Next.js

Items 1, 2, 4–10 can all be applied in one place via `next.config.js` `headers()` or a `middleware.ts` response-header injection. Consolidating them reduces the risk of missing a route:

```js
// next.config.js
async headers() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        // CSP should be applied separately with nonce support
      ],
    },
  ]
},
poweredByHeader: false,
```

---

## Informational (No Action Required)

| Alert                              | Notes                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Authentication Request Identified  | ZAP detected the login flow correctly — expected behaviour.            |
| Modern Web Application             | Informational only.                                                    |
| Non-Storable Content               | 4 API responses correctly prevent caching — no action needed.          |
| Storable and Cacheable Content     | Systemic — static assets; review if any sensitive routes are included. |
| Storable but Non-Cacheable Content | 1 instance — verify it is not a sensitive endpoint.                    |

---

## Definition of Done for Next Patch

The patch is complete when a re-run of `zap-baseline.py` against the staging revision produces:

- **0 Medium alerts** (rules 10202, 10038, 10020)
- **0 Low alerts** (rules 10035, 10021, 10063, 10037, 90004)
- No new High or Critical alerts introduced
