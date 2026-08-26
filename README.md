# Harumphers

Harumphers is a small member directory and event-management PWA. The static app is served separately from a Cloudflare Worker API, which is the only component allowed to communicate with Airtable.

## Security and cost boundaries

- The browser never receives Airtable credentials and cannot call arbitrary Airtable paths.
- Every API route has an explicit method and role policy: guest, member, or administrator.
- Sessions are signed by the Worker and expire after 12 hours.
- Airtable remains the system of record; this design requires no Airtable subscription upgrade or new hardware.
- Directory and event reads use the Cloudflare cache for 24 hours, with a bounded stale fallback during a temporary Airtable outage. Successful writes invalidate affected cached views.
- Uploaded photos must be JPEG, PNG, or WebP, are capped at 1 MB, and are validated from their file contents before upload.

## Local working model

The local server uses deterministic synthetic fixtures and the real Worker routing code. It does not read an Airtable token and cannot modify live Airtable data.

```bash
npm ci
npx playwright install chromium webkit
npm run dev
```

Open <http://127.0.0.1:4173/>. Synthetic logins:

- Member number: `42001`
- Administrator password: `fixture-admin-password`
- Guest phrase: `fixture-guest-phrase`

Changes made in the model last only until the local server restarts.

## Verification

```bash
npm run test:unit
npm run test:security
npm run test:browser
npm test
```

The browser suite covers Chromium and WebKit, the latter providing the closest automated approximation of iPhone Safari. It exercises enlarged-text phone layouts, horizontal overflow, keyboard and screen-reader semantics, offline loading, hostile display data, member workflows, administrator workflows, and member-number approval.

## Worker configuration

Non-secret Airtable resource identifiers and allowed origins live in `worker/wrangler.toml`. Configure secret values only through Wrangler; never place them in source files or CI variables printed to logs:

```bash
cd worker
npx wrangler secret put AIRTABLE_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GUEST_LOGIN
npx wrangler secret put ADMIN_LOGIN
```

`SESSION_SECRET` must be at least 32 characters. The public health check is `GET /api/health`; it returns only service readiness metadata.

## Pre-deployment checklist

1. Run `npm test` from a clean checkout.
2. Review the diff for secret values and direct browser-to-Airtable requests.
3. Deploy the Worker to a staging URL and configure the four Worker secrets there.
4. Point a staging copy of the static app at that Worker and verify authenticated member and administrator workflows against staging-only data.
5. Verify `/api/health`, cache refresh after a write, iPhone Safari layout at enlarged text, and offline app-shell loading.
6. Keep the previous Worker version and static-site commit available as the rollback targets.

Production deployment is intentionally separate from local-model approval.
