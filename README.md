# Harumphers

Harumphers is a small member directory and event-management PWA. The static app is served separately from a Cloudflare Worker API, which is the only component allowed to communicate with Airtable.

## Security and cost boundaries

- The browser never receives Airtable credentials and cannot call arbitrary Airtable paths.
- Every API route has an explicit method and role policy: guest, member, or administrator.
- Sessions are signed by the Worker and expire after 12 hours.
- Airtable remains the system of record; this design requires no Airtable subscription upgrade or new hardware.
- Directory and event reads use Cloudflare's per-location cache for 15 minutes, with a bounded stale fallback for up to 24 hours during a temporary Airtable outage. Successful writes invalidate the current location immediately; other locations age out within 15 minutes.
- Cloudflare's Worker rate-limit bindings protect public login attempts and member-number approval requests without adding an Airtable subscription or new hardware.
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

### Required Airtable schema

Before any staging deploy, create a separate staging base and confirm these tables and exact fields. Record-ID fields are single-line text unless noted:

- Members: `FULL NAME`, `CELL #`, `E-MAIL ADDRESS`, `PHOTO` (attachments), `IN DIRECTORY` (checkbox), `MEMBER #` (single-line text), and `IS ADMIN` (checkbox). A member with `IS ADMIN` checked keeps his member identity and receives administrator controls when signing in with his member number.
- Events: `EVENT NAME`, `DATE` (date), `SPEAKER`, `TIME`, `ROOM`, `SPEAKER PHOTO` (attachments), `NOTES` (long text), `Status` (Suggested, Upcoming, Scheduled, Completed, Cancelled), `RSVP FIELD`, `GUEST FIELD`, `CREATION KEY`, and `SETUP STATE`.
- Photos: `EVENT RECORD ID`, `MEMBER RECORD ID`, `MEMBER NAME`, `PHOTO` (attachments), `CAPTION` (long text), and `SUBMITTED` (date).
- Attendance: `EVENT RECORD ID`, `MEMBER RECORD ID`, `ATTENDED` (checkbox), and `ACTUAL GUESTS` (integer).
- Votes: `EVENT RECORD ID`, `MEMBER RECORD ID`, and `VOTE` (UP or DOWN).
- Member Requests: `SUBMITTED NAME`, `SUBMITTED MEMBER #` (integer), `STATUS` (Pending, Approved, Rejected), `SUBMITTED DATE` (date), and `LINKED MEMBER ID`.

The staging Airtable token needs record read/write access and schema read/write access because promoting or creating a scheduled event creates exact RSVP and guest fields in Members. Do not use the live base or live token for staging.

### Safe staging commands

Wrangler's staging environment has a distinct Worker name and deliberately invalid Airtable placeholders, so a bare staging deploy cannot reach the live base. Set the staging identifiers in task-specific shell variables, verify none are empty, and deploy with explicit overrides:

```bash
cd worker
npx wrangler secret put AIRTABLE_TOKEN --env staging
npx wrangler secret put SESSION_SECRET --env staging
npx wrangler secret put GUEST_LOGIN --env staging
npx wrangler secret put ADMIN_LOGIN --env staging

test -n "$HARUMPHERS_STAGING_BASE_ID" \
  -a -n "$HARUMPHERS_STAGING_MEMBERS_TABLE_ID" \
  -a -n "$HARUMPHERS_STAGING_EVENTS_TABLE_ID" \
  -a -n "$HARUMPHERS_STAGING_PHOTOS_TABLE_ID" \
  -a -n "$HARUMPHERS_STAGING_ATTENDANCE_TABLE_ID" \
  -a -n "$HARUMPHERS_STAGING_VOTES_TABLE_ID" \
  -a -n "$HARUMPHERS_STAGING_MEMBER_REQUESTS_TABLE_ID"

npx wrangler deploy --env staging \
  --var AIRTABLE_BASE_ID:"$HARUMPHERS_STAGING_BASE_ID" \
  --var AIRTABLE_MEMBERS_TABLE_ID:"$HARUMPHERS_STAGING_MEMBERS_TABLE_ID" \
  --var AIRTABLE_EVENTS_TABLE_ID:"$HARUMPHERS_STAGING_EVENTS_TABLE_ID" \
  --var AIRTABLE_PHOTOS_TABLE_ID:"$HARUMPHERS_STAGING_PHOTOS_TABLE_ID" \
  --var AIRTABLE_ATTENDANCE_TABLE_ID:"$HARUMPHERS_STAGING_ATTENDANCE_TABLE_ID" \
  --var AIRTABLE_VOTES_TABLE_ID:"$HARUMPHERS_STAGING_VOTES_TABLE_ID" \
  --var AIRTABLE_MEMBER_REQUESTS_TABLE_ID:"$HARUMPHERS_STAGING_MEMBER_REQUESTS_TABLE_ID" \
  --var ALLOWED_ORIGINS:http://127.0.0.1:4174
```

Build a local static copy whose API origin is the staging Worker, then preview it separately from the fixture model:

```bash
cd ..
npm run build:staging
npm run preview:staging
```

Open <http://127.0.0.1:4174/>. `dist-staging/` is generated and ignored; the production-origin source pages are not changed.

## Pre-deployment checklist

1. Run `npm test` from a clean checkout.
2. Review the diff for secret values and direct browser-to-Airtable requests.
3. Verify the separate staging Airtable schema above, then use only the explicit `--env staging` command and staging-only identifiers.
4. Build and open the staging-origin static copy, then verify authenticated member and administrator workflows against staging-only data.
5. Verify `/api/health`, write visibility (immediate locally and bounded to 15 minutes across Cloudflare locations), rate limiting, iPhone Safari layout at enlarged text, and offline app-shell loading.
6. Keep the previous Worker version and static-site commit available as the rollback targets.

Production deployment is intentionally separate from local-model approval.
