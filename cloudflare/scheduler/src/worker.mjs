// CAS-1000: Cloudflare Worker that dispatches uptime.yml, daily.yml and alerts.yml on time via
// GitHub's workflow_dispatch API. GitHub's own `schedule` trigger is not dependable for this repo
// (see the ticket) — workflow_dispatch events are not subject to the same delay.
//
// CAS-1525: the Worker has ONE Cron Trigger, `*/5 * * * *` (UTC), because Cloudflare's free plan allows
// only 5 per account and the old per-job crons (10) made the deploy fail. Each tick works out the Sydney
// local hour and minute (DST-aware, via Intl) and dispatches what is due in that 5-minute window:
//   01:00-01:04 -> daily.yml
//   03:00-03:04 -> alerts.yml (phase=find)
//   07:30-07:34 -> alerts.yml (phase=push)
//   17:00-17:04 -> alerts.yml (phase=email)
//   minute 15-19 of every hour -> uptime.yml
//   every tick  -> recommend.yml, ONLY if Supabase reports unsent mail (or can't be reached) (CAS-1130)
// One tick may dispatch several workflows; each dispatch keeps its own retry-once and failure email.
// CAS-1503: alerts go out overnight (03:00 Sydney); the refresh runs at 01:00 so alerts use that night's data.
// CAS-1504: alerts are split by channel. 03:00 finds and records them (sends nothing), 07:30 sends the one
// push, 17:00 emails only the alerts the member has not seen in the app. All three dispatch alerts.yml; the
// `phase` workflow input says which.

export const REPO = "codynamics/cascade-web";
export const GITHUB_API = "https://api.github.com";
export const RESEND_API = "https://api.resend.com/emails";
export const USER_AGENT = "cascade-scheduler-worker/1.0 (+https://cascademovies.com)";
export const RETRY_DELAY_MS = 30000;

export const CRON = {
  TICK: "*/5 * * * *",
};

export const DAILY_SYDNEY_HOUR = 1;
export const ALERTS_SYDNEY_HOUR = 3;
export const PUSH_SYDNEY_TIME = { hour: 7, minute: 30 };
export const EMAIL_SYDNEY_HOUR = 17;
export const UPTIME_SYDNEY_MINUTE = 15;
export const TICK_MINUTES = 5;

// Tables/columns CAS-1130 checks for unsent outgoing mail before dispatching recommend.yml.
export const UNSENT_MAIL_CHECKS = [
  { table: "recommendations", column: "sent_at" },
  { table: "invite_emails", column: "sent_at" },
  { table: "invite_replies", column: "notified_at" },
];

// The Sydney local hour (0-23) and minute at `epochMs`, DST-aware via the runtime's own tz database.
export function sydneyClock(epochMs) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { hour: get("hour"), minute: get("minute") };
}

// True if `minute` falls in the 5-minute window that starts at `start`.
function inWindow(minute, start) {
  return minute >= start && minute < start + TICK_MINUTES;
}

// The dispatches (other than recommend.yml) due for the tick at `epochMs`:
// [{ workflow, inputs }], where inputs is null or a workflow_dispatch inputs object.
export function dispatchesForTick(epochMs) {
  const { hour, minute } = sydneyClock(epochMs);
  const due = [];
  if (hour === DAILY_SYDNEY_HOUR && inWindow(minute, 0)) due.push({ workflow: "daily.yml", inputs: null });
  if (hour === ALERTS_SYDNEY_HOUR && inWindow(minute, 0)) due.push({ workflow: "alerts.yml", inputs: { phase: "find" } });
  if (hour === PUSH_SYDNEY_TIME.hour && inWindow(minute, PUSH_SYDNEY_TIME.minute)) {
    due.push({ workflow: "alerts.yml", inputs: { phase: "push" } });
  }
  if (hour === EMAIL_SYDNEY_HOUR && inWindow(minute, 0)) due.push({ workflow: "alerts.yml", inputs: { phase: "email" } });
  if (inWindow(minute, UPTIME_SYDNEY_MINUTE)) due.push({ workflow: "uptime.yml", inputs: null });
  return due;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchOnce(env, workflowFile, fetchImpl, inputs) {
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
      body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
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
// or thrown error, then emailing ALERT_TO if it still fails. Never throws. `deps.inputs` (CAS-1504) are
// the workflow_dispatch inputs, e.g. { phase: "push" }.
export async function dispatchWorkflow(env, workflowFile, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleepImpl = deps.sleep || sleep;
  const inputs = deps.inputs || null;

  let result = await dispatchOnce(env, workflowFile, fetchImpl, inputs);
  console.log(`scheduler: dispatch ${workflowFile} attempt 1 -> ${result.ok ? 204 : result.status}`);
  if (result.ok) return result;

  await sleepImpl(RETRY_DELAY_MS);
  result = await dispatchOnce(env, workflowFile, fetchImpl, inputs);
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

async function handleRecommend(env) {
  const shouldDispatch = await hasUnsentMail(env);
  if (!shouldDispatch) {
    console.log("scheduler: no unsent mail, no recommend dispatch");
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
    const when = event.scheduledTime ?? Date.now();
    const due = dispatchesForTick(when);
    if (due.length === 0) console.log(`scheduler: cron "${event.cron}" fired, nothing time-based due`);
    for (const { workflow, inputs } of due) {
      try {
        await dispatchWorkflow(env, workflow, { inputs });
      } catch (err) {
        // Belt-and-braces: dispatchWorkflow already catches its own errors, but the handler must
        // never throw out silently regardless.
        console.log(`scheduler: unexpected error dispatching ${workflow}: ${(err && err.message) || err}`);
      }
    }
    await handleRecommend(env);
  },
};
