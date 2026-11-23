# cascade-scheduler (CAS-1000)

A Cloudflare Worker that dispatches Cascade's scheduled GitHub Actions workflows on time.
GitHub's own `schedule` trigger runs late/unreliably for this repo; a Worker Cron Trigger
calling `workflow_dispatch` is not subject to the same delay.

## What it triggers

One Cron Trigger (UTC, declared in `wrangler.toml`): `*/5 * * * *`. Cloudflare's free plan allows only
5 cron triggers per account, so (CAS-1525) every job hangs off this one tick. Each tick works out the
Sydney local hour and minute (DST-aware, `Intl.DateTimeFormat`) and calls
`POST /repos/codynamics/cascade-web/actions/workflows/<file>/dispatches` with `{"ref":"main"}` for
whatever is due:

| Sydney local time of the tick | Dispatches |
| --- | --- |
| 01:00-01:04 | `daily.yml` |
| 03:00-03:04 | `alerts.yml` `phase=find` |
| 07:30-07:34 | `alerts.yml` `phase=push` |
| 17:00-17:04 | `alerts.yml` `phase=email` |
| minute 15-19 of every hour | `uptime.yml` |
| every tick | `recommend.yml`, only if Supabase reports unsent mail (or can't be reached) |

One tick can dispatch more than one workflow (e.g. uptime and recommend); each dispatch has its own
retry and failure email.

CAS-1503: the refresh runs at 01:00 Sydney and alerts go out at 03:00 Sydney, so alerts are built
from that night's data. Because the gate is Sydney local time, daylight saving needs no second cron. `uptime.yml` keeps its own GitHub `schedule` as a backup; the
Worker is additive there, not a replacement.

CAS-1504: alerts are split by channel, all three dispatching `alerts.yml` with a `phase` input
(`{"ref":"main","inputs":{"phase":"..."}}`): 03:00 `find` records the night's alerts to the ledger and
sends nothing; 07:30 `push` sends one push per member with unread alerts; 17:00 `email` sends the digest of
only the alerts the member has not seen in the app. Every other workflow is still dispatched with just
`{"ref":"main"}`.

CAS-1130: every tick reads one row (`limit=1`) from each of
`recommendations?sent_at=is.null`, `invite_emails?sent_at=is.null` and
`invite_replies?notified_at=is.null` via the Supabase REST API. It dispatches `recommend.yml`
only if any of those returns a row, or if Supabase can't be reached at all — never silently
skips a send because of a transient Supabase error. `recommend.yml` keeps its own hourly
`schedule` as a fallback, same as `uptime.yml`.

On any non-204 response or a thrown error, the dispatch is retried once after 30 seconds. If
that also fails, `ALERT_TO` is emailed via Resend with the workflow name, status and response
body. Every outcome is also logged with `console.log`, visible in the Worker's Cloudflare logs.

## Secrets (Worker, set by `deploy-scheduler.yml`)

The Worker reads these at runtime — never checked into this repo:

- `GH_DISPATCH_TOKEN` — a GitHub fine-grained PAT scoped to `codynamics/cascade-web`, Actions: Read
  and write. Sourced from the GitHub Actions secret `SCHEDULER_GH_TOKEN`.
- `RESEND_API_KEY` — sourced from the GitHub Actions secret of the same name.
- `ALERT_TO` — sourced from the GitHub Actions secret `CASCADE_ALERT_TO`.
- `ALERT_FROM` — sourced from the GitHub Actions secret `CASCADE_EMAIL_FROM`.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — CAS-1130, used only to check for unsent mail
  before dispatching `recommend.yml`. Sourced from the GitHub Actions secrets of the same name
  (the ones `recommend.yml` itself already uses).

The Worker never needs a Cloudflare credential itself — only the deploy step does.

## Redeploying

Run `.github/workflows/deploy-scheduler.yml` from the Actions tab (`workflow_dispatch` only).
It deploys `cloudflare/scheduler` with `cloudflare/wrangler-action`, using the GitHub Actions
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then re-sets the Worker secrets
above from the GitHub secrets listed. Re-run it any time this folder changes.

## Tests

`npm run test:scheduler` (also part of `npm run qa`) runs `test/scheduler.test.mjs` — a plain
`node:test` suite with a stubbed `fetch` and a stubbed clock/sleep, no network and no Cloudflare
account needed.
