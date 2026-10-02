// CAS-1000: Cloudflare Worker that dispatches uptime.yml, daily.yml and alerts.yml on time via
// GitHub's workflow_dispatch API. GitHub's own `schedule` trigger is not dependable for this repo
// (see the ticket) — workflow_dispatch events are not subject to the same delay.
//
// CAS-1130: a fifth cron checks Supabase every 5 minutes for unsent outgoing mail (recommendations,
// invite emails, invite replies) and only dispatches recommend.yml when there is some to send, so it
// doesn't cost Actions minutes running unconditionally every 5 minutes.
//
// Cron Triggers (UTC, declared in wrangler.toml):
//   17 * * * *  -> uptime.yml every hour
//   0 20 * * *  -> daily.yml once a day
//   0 6 * * *   -> alerts.yml, ONLY if this instant is 17:00 in Australia/Sydney (AEDT)
//   0 7 * * *   -> alerts.yml, ONLY if this instant is 17:00 in Australia/Sydney (AEST)
//   */5 * * * * -> recommend.yml, ONLY if Supabase reports unsent mail (or can't be reached)
// Exactly one of the alerts crons fires per day across the daylight-saving switch, computed with
// Intl.DateTimeFormat rather than a fixed UTC offset.

export const REPO = "codynamics/cascade-web";
export const GITHUB_API = "https://api.github.com";
export const RESEND_API = "https://api.resend.com/emails";
export const USER_AGENT = "cascade-scheduler-worker/1.0 (+https://cascademovies.com)";
export const RETRY_DELAY_MS = 30000;

export const CRON = {
  UPTIME: "17 * * * *",
  DAILY: "0 20 * * *",
  ALERTS_A: "0 6 * * *",
  ALERTS_B: "0 7 * * *",
  RECOMMEND: "*/5 * * * *",
};

const WORKFLOW_FOR_CRON = {
  [CRON.UPTIME]: "uptime.yml",
  [CRON.DAILY]: "daily.yml",
};

// Tables/columns CAS-1130 checks for unsent outgoing mail before dispatching recommend.yml.
export const UNSENT_MAIL_CHECKS = [
  { table: "recommendations", column: "sent_at" },
  { table: "invite_emails", column: "sent_at" },
  { table: "invite_replies", column: "notified_at" },
];

// The Sydney local hour (0-23) at `epochMs`, DST-aware via the runtime's own tz database.
export function sydneyHour(epochMs) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  return Number(parts.find((p) => p.type === "hour").value);
}

// Which workflow file (if any) this cron firing, at this instant, should dispatch.
export function targetForCron(cron, epochMs) {
  if (cron === CRON.ALERTS_A || cron === CRON.ALERTS_B) {
    return sydneyHour(epochMs) === 17 ? "alerts.yml" : null;
  }
  return WORKFLOW_FOR_CRON[cron] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchOnce(env, workflowFile, fetchImpl) {
  const url = `${GITHUB_API}/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_DISPATCH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status === 204) return { ok: true, status: 204, body: "" };
    let body = "";
    try {
      body = await res.text();
    } catch {
      // best-effort only — the status code is what matters for the retry/alert decision
    }
    return { ok: false, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String((err && err.message) || err) };
  }
}

async function sendFailureAlert(env, workflowFile, result, fetchImpl) {
  const payload = {
    from: env.ALERT_FROM,
    to: [env.ALERT_TO],
    subject: `Cascade scheduler: ${workflowFile} dispatch failed`,
    text: `Dispatching ${workflowFile} to GitHub failed twice.\nStatus: ${result.status}\nBody: ${result.body}`,
  };
  try {
    await fetchImpl(RESEND_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.log(`scheduler: alert email itself failed for ${workflowFile}: ${(err && err.message) || err}`);
  }
}

// Dispatches `workflowFile` on `main`, retrying once after RETRY_DELAY_MS on any non-204 response
// or thrown error, then emailing ALERT_TO if it still fails. Never throws.
export async function dispatchWorkflow(env, workflowFile, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleepImpl = deps.sleep || sleep;

  let result = await dispatchOnce(env, workflowFile, fetchImpl);
  console.log(`scheduler: dispatch ${workflowFile} attempt 1 -> ${result.ok ? 204 : result.status}`);
  if (result.ok) return result;

  await sleepImpl(RETRY_DELAY_MS);
  result = await dispatchOnce(env, workflowFile, fetchImpl);
  console.log(`scheduler: dispatch ${workflowFile} attempt 2 -> ${result.ok ? 204 : result.status}`);
  if (result.ok) return result;

  console.log(`scheduler: dispatch ${workflowFile} failed twice, emailing ${env.ALERT_TO}`);
  await sendFailureAlert(env, workflowFile, result, fetchImpl);
  return result;
}

// True if any of UNSENT_MAIL_CHECKS has an unsent row, or if a check can't be reached — in which
// case CAS-1130 says to dispatch anyway rather than risk silently never sending.
export async function hasUnsentMail(env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;

  for (const { table, column } of UNSENT_MAIL_CHECKS) {
    const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=id&${column}=is.null&limit=1`;
    try {
      const res = await fetchImpl(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!res.ok) {
        console.log(`scheduler: Supabase check for ${table} returned ${res.status}, dispatching anyway`);
        return true;
      }
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return true;
    } catch (err) {
      console.log(`scheduler: Supabase check for ${table} failed (${(err && err.message) || err}), dispatching anyway`);
      return true;
    }
  }
  return false;
}

async function handleRecommendCron(event, env) {
  const shouldDispatch = await hasUnsentMail(env);
  if (!shouldDispatch) {
    console.log(`scheduler: cron "${event.cron}" fired, no unsent mail, no dispatch`);
    return;
  }
  try {
    await dispatchWorkflow(env, "recommend.yml");
  } catch (err) {
    console.log(`scheduler: unexpected error dispatching recommend.yml: ${(err && err.message) || err}`);
  }
}

export default {
  async scheduled(event, env) {
    if (event.cron === CRON.RECOMMEND) {
      await handleRecommendCron(event, env);
      return;
    }

    const workflowFile = targetForCron(event.cron, event.scheduledTime ?? Date.now());
    if (!workflowFile) {
      console.log(`scheduler: cron "${event.cron}" fired, no dispatch (not 17:00 Sydney)`);
      return;
    }
    try {
      await dispatchWorkflow(env, workflowFile);
    } catch (err) {
      // Belt-and-braces: dispatchWorkflow already catches its own errors, but the handler must
      // never throw out silently regardless.
      console.log(`scheduler: unexpected error dispatching ${workflowFile}: ${(err && err.message) || err}`);
    }
  },
};
