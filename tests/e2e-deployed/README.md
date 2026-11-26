# Real-user check on the deployed site (CAS-1574)

`deployed-smoke.spec.mjs` is one person on the DEPLOYED staging site (https://cascade-web-3x1.pages.dev/), WebKit
iPhone 13, 390x844, against staging's real database and real email. It runs from `.github/workflows/deployed-smoke.yml`,
called by `qa.yml` after the gate is green on every push to `staging`. A red run reds the qa run, so the push's tickets
are not marked On Staging and are requeued.

It waits (up to 15 min) for the site to serve the commit stamped in the pushed commit's `version.json`, checks
`CASCADE_CONFIG.ENV`, signs up as `lee+CascadeQA@codynamics.com.au` with promo code CASCADEFRIENDS, reads the six-digit
code from the real email, does first-run setup, opens a film, saves a watched answer, changes an alert setting, signs
out and back in and checks all three persisted, then fails on any console error or failed request to the site's own
hosts. The test account is deleted before and after every run.

Production is NOT covered here: it is a separate ticket.

## Keeping it current

Any ticket that changes sign-up, onboarding, first-run setup, or the features the spec uses (film card, watched answer,
Notification Settings, sign out / sign in) must update `deployed-smoke.spec.mjs` in the same commit.

## Secrets (GitHub `staging` environment)

| Secret | Used for |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | deleting the test account before and after (already set) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | reading the sign-in email through Microsoft Graph |

If the three `MS_*` secrets are missing, the email checks report **Blocked** (not Fail) and the rest still runs, taking
the code through the Supabase admin API instead. That run is recorded as Blocked in cascade-qa.

### Mailbox setup (one-off, Lee)

The staging sign-up email goes to `lee+CascadeQA@codynamics.com.au`, which lands in `lee@codynamics.com.au`.

1. Entra admin centre, App registrations, New registration (single tenant), name `cascade-qa-mail-reader`.
2. API permissions, Add, Microsoft Graph, **Application permissions**, `Mail.Read` only. Grant admin consent.
3. Certificates & secrets, New client secret. Copy the value now.
4. Limit it to Lee's mailbox only (Exchange Online PowerShell):
   ```powershell
   New-DistributionGroup -Name "cascade-qa-mail-scope" -Type Security -Members lee@codynamics.com.au
   New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId cascade-qa-mail-scope@codynamics.com.au `
     -AccessRight RestrictAccess -Description "cascade-qa-mail-reader: Lee's mailbox only"
   Test-ApplicationAccessPolicy -Identity lee@codynamics.com.au -AppId <client id>   # expect Granted
   ```
5. Add `MS_TENANT_ID` (directory id), `MS_CLIENT_ID` (application id) and `MS_CLIENT_SECRET` to the GitHub `staging`
   environment (repo Settings, Environments, staging).

The spec only lists messages received after the run started and only uses those addressed to
`lee+CascadeQA@codynamics.com.au`. It logs the subject only, never the body.
