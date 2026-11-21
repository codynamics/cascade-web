import { test } from "node:test";
import assert from "node:assert/strict";

import worker, {
  CRON,
  GITHUB_API,
  RESEND_API,
  REPO,
  RETRY_DELAY_MS,
  UNSENT_MAIL_CHECKS,
  targetForCron,
  inputsForCron,
  dispatchWorkflow,
  hasUnsentMail,
} from "../src/worker.mjs";

const ENV = {
  GH_DISPATCH_TOKEN: "gh-test-token",
  RESEND_API_KEY: "resend-test-key",
  ALERT_TO: "lee@codynamics.com.au",
  ALERT_FROM: "Cascade <alerts@cascademovies.com>",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "supabase-test-key",
};

function fakeResponse(status, body = "") {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

function fakeJsonResponse(status, rows = []) {
  return { status, ok: status >= 200 && status < 300, json: async () => rows };
}

test("17 * * * * always dispatches uptime.yml", () => {
  assert.equal(targetForCron(CRON.UPTIME, Date.parse("2026-09-17T00:17:00Z")), "uptime.yml");
});

test("during AEDT, 16:00 UTC dispatches alerts.yml and 17:00 UTC does not", () => {
  // 2026-11-22 is after AU DST starts (first Sunday of October) -> Sydney is UTC+11.
  assert.equal(targetForCron(CRON.ALERTS_A, Date.parse("2026-11-22T16:00:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.ALERTS_B, Date.parse("2026-11-22T17:00:00Z")), null);
});

test("during AEST, 17:00 UTC dispatches alerts.yml and 16:00 UTC does not", () => {
  // 2026-07-15 is outside AU DST -> Sydney is UTC+10.
  assert.equal(targetForCron(CRON.ALERTS_A, Date.parse("2026-07-15T16:00:00Z")), null);
  assert.equal(targetForCron(CRON.ALERTS_B, Date.parse("2026-07-15T17:00:00Z")), "alerts.yml");
});

// CAS-1504: 07:30 push pair and 17:00 email pair.

test("during AEDT, 20:30 UTC dispatches the push phase and 21:30 UTC does not", () => {
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-11-22T20:30:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-11-22T21:30:00Z")), null);
});

test("during AEST, 21:30 UTC dispatches the push phase and 20:30 UTC does not", () => {
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-07-15T20:30:00Z")), null);
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-07-15T21:30:00Z")), "alerts.yml");
});

test("the push pair only dispatches at 07:00-07:59 Sydney, on each side of DST", () => {
  // AEDT (UTC+11): 20:00 UTC is 07:00, 20:59 is 07:59, 21:00 is 08:00, 19:59 is 06:59.
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-11-22T20:00:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-11-22T20:59:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-11-22T21:00:00Z")), null);
  assert.equal(targetForCron(CRON.PUSH_A, Date.parse("2026-11-22T19:59:00Z")), null);
  // AEST (UTC+10): 21:00 UTC is 07:00, 21:59 is 07:59, 22:00 is 08:00, 20:59 is 06:59.
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-07-15T21:00:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-07-15T21:59:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-07-15T22:00:00Z")), null);
  assert.equal(targetForCron(CRON.PUSH_B, Date.parse("2026-07-15T20:59:00Z")), null);
});

test("during AEDT, 06:00 UTC dispatches the email phase and 07:00 UTC does not", () => {
  assert.equal(targetForCron(CRON.EMAIL_A, Date.parse("2026-11-22T06:00:00Z")), "alerts.yml");
  assert.equal(targetForCron(CRON.EMAIL_B, Date.parse("2026-11-22T07:00:00Z")), null);
});

test("during AEST, 07:00 UTC dispatches the email phase and 06:00 UTC does not", () => {
  assert.equal(targetForCron(CRON.EMAIL_A, Date.parse("2026-07-15T06:00:00Z")), null);
  assert.equal(targetForCron(CRON.EMAIL_B, Date.parse("2026-07-15T07:00:00Z")), "alerts.yml");
});

test("each alerts cron passes its own phase input; other crons pass none", () => {
  assert.deepEqual(inputsForCron(CRON.ALERTS_A), { phase: "find" });
  assert.deepEqual(inputsForCron(CRON.ALERTS_B), { phase: "find" });
  assert.deepEqual(inputsForCron(CRON.PUSH_A), { phase: "push" });
  assert.deepEqual(inputsForCron(CRON.PUSH_B), { phase: "push" });
  assert.deepEqual(inputsForCron(CRON.EMAIL_A), { phase: "email" });
  assert.deepEqual(inputsForCron(CRON.EMAIL_B), { phase: "email" });
  assert.equal(inputsForCron(CRON.UPTIME), null);
  assert.equal(inputsForCron(CRON.DAILY_A), null);
});

test("dispatching with a phase puts it in the request body's inputs", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse(204);
  };
  await dispatchWorkflow(ENV, "alerts.yml", { fetch: fetchStub, sleep: async () => {}, inputs: { phase: "push" } });
  assert.equal(calls[0].init.body, JSON.stringify({ ref: "main", inputs: { phase: "push" } }));
});

test("the scheduled handler dispatches alerts.yml with phase=push at 07:30 AEDT only", async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: init.body });
    return fakeResponse(204);
  };
  try {
    await worker.scheduled({ cron: CRON.PUSH_A, scheduledTime: Date.parse("2026-11-22T20:30:00Z") }, ENV);
    await worker.scheduled({ cron: CRON.PUSH_B, scheduledTime: Date.parse("2026-11-22T21:30:00Z") }, ENV);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].url, /workflows\/alerts\.yml\/dispatches$/);
  assert.equal(bodies[0].body, JSON.stringify({ ref: "main", inputs: { phase: "push" } }));
});

test("during AEDT, 14:00 UTC dispatches daily.yml and 15:00 UTC does not", () => {
  assert.equal(targetForCron(CRON.DAILY_A, Date.parse("2026-11-22T14:00:00Z")), "daily.yml");
  assert.equal(targetForCron(CRON.DAILY_B, Date.parse("2026-11-22T15:00:00Z")), null);
});

test("during AEST, 15:00 UTC dispatches daily.yml and 14:00 UTC does not", () => {
  assert.equal(targetForCron(CRON.DAILY_A, Date.parse("2026-07-15T14:00:00Z")), null);
  assert.equal(targetForCron(CRON.DAILY_B, Date.parse("2026-07-15T15:00:00Z")), "daily.yml");
});

test("a 204 makes exactly one request and needs no retry or alert", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse(204);
  };
  const result = await dispatchWorkflow(ENV, "uptime.yml", { fetch: fetchStub, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("the dispatch request has the exact URL, method, headers and body", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse(204);
  };
  await dispatchWorkflow(ENV, "daily.yml", { fetch: fetchStub, sleep: async () => {} });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${GITHUB_API}/repos/${REPO}/actions/workflows/daily.yml/dispatches`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer gh-test-token");
  assert.equal(init.headers.Accept, "application/vnd.github+json");
  assert.ok(init.headers["User-Agent"]);
  assert.equal(init.body, JSON.stringify({ ref: "main" }));
});

test("a 500 from GitHub is retried once after 30s, then one Resend email is sent", async () => {
  const calls = [];
  let sleepCalls = 0;
  const fetchStub = async (url) => {
    calls.push(url);
    if (url.startsWith(GITHUB_API)) return fakeResponse(500, "server error");
    return fakeResponse(200, "{}");
  };
  const sleepStub = async (ms) => {
    sleepCalls += 1;
    assert.equal(ms, RETRY_DELAY_MS);
  };
  const result = await dispatchWorkflow(ENV, "alerts.yml", { fetch: fetchStub, sleep: sleepStub });
  assert.equal(result.ok, false);
  assert.equal(sleepCalls, 1);
  assert.equal(calls.filter((u) => u.startsWith(GITHUB_API)).length, 2);
  assert.equal(calls.filter((u) => u === RESEND_API).length, 1);
});

test("the failure email names the workflow and the failing status", async () => {
  let emailBody = null;
  const fetchStub = async (url, init) => {
    if (url.startsWith(GITHUB_API)) return fakeResponse(500, "boom");
    emailBody = JSON.parse(init.body);
    return fakeResponse(200, "{}");
  };
  await dispatchWorkflow(ENV, "alerts.yml", { fetch: fetchStub, sleep: async () => {} });
  assert.ok(emailBody);
  assert.match(emailBody.text, /alerts\.yml/);
  assert.match(emailBody.text, /500/);
  assert.deepEqual(emailBody.to, [ENV.ALERT_TO]);
});

test("a second-attempt success sends no alert email", async () => {
  const calls = [];
  let githubAttempts = 0;
  const fetchStub = async (url) => {
    calls.push(url);
    if (url.startsWith(GITHUB_API)) {
      githubAttempts += 1;
      return githubAttempts === 1 ? fakeResponse(500, "server error") : fakeResponse(204);
    }
    return fakeResponse(200, "{}");
  };
  const result = await dispatchWorkflow(ENV, "daily.yml", { fetch: fetchStub, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((u) => u === RESEND_API).length, 0);
});

// CAS-1130: */5 * * * * only dispatches recommend.yml when there's unsent mail.

test("hasUnsentMail checks all three tables with the exact Supabase REST URLs", async () => {
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    return fakeJsonResponse(200, []);
  };
  await hasUnsentMail(ENV, { fetch: fetchStub });
  assert.equal(calls.length, UNSENT_MAIL_CHECKS.length);
  assert.equal(calls[0], `${ENV.SUPABASE_URL}/rest/v1/recommendations?select=id&sent_at=is.null&limit=1`);
  assert.equal(calls[1], `${ENV.SUPABASE_URL}/rest/v1/invite_emails?select=id&sent_at=is.null&limit=1`);
  assert.equal(calls[2], `${ENV.SUPABASE_URL}/rest/v1/invite_replies?select=id&notified_at=is.null&limit=1`);
});

test("hasUnsentMail is false when all three tables report no unsent rows", async () => {
  const fetchStub = async () => fakeJsonResponse(200, []);
  assert.equal(await hasUnsentMail(ENV, { fetch: fetchStub }), false);
});

test("hasUnsentMail is true when any table has an unsent row", async () => {
  const fetchStub = async (url) => {
    if (url.includes("invite_emails")) return fakeJsonResponse(200, [{ id: 1 }]);
    return fakeJsonResponse(200, []);
  };
  assert.equal(await hasUnsentMail(ENV, { fetch: fetchStub }), true);
});

test("hasUnsentMail dispatches anyway when Supabase returns an error status", async () => {
  const fetchStub = async () => fakeJsonResponse(500, []);
  assert.equal(await hasUnsentMail(ENV, { fetch: fetchStub }), true);
});

test("hasUnsentMail dispatches anyway when Supabase can't be reached", async () => {
  const fetchStub = async () => {
    throw new Error("network down");
  };
  assert.equal(await hasUnsentMail(ENV, { fetch: fetchStub }), true);
});

test("*/5 * * * * dispatches recommend.yml when an unsent row is present", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.startsWith(ENV.SUPABASE_URL)) {
      return fakeJsonResponse(200, url.includes("recommendations") ? [{ id: 1 }] : []);
    }
    return fakeResponse(204);
  };
  try {
    await worker.scheduled({ cron: CRON.RECOMMEND, scheduledTime: Date.now() }, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.includes(`${GITHUB_API}/repos/${REPO}/actions/workflows/recommend.yml/dispatches`));
});

test("*/5 * * * * makes no dispatch when there is no unsent mail", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.startsWith(ENV.SUPABASE_URL)) return fakeJsonResponse(200, []);
    return fakeResponse(204);
  };
  try {
    await worker.scheduled({ cron: CRON.RECOMMEND, scheduledTime: Date.now() }, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.filter((u) => u.startsWith(GITHUB_API)).length, 0);
});

test("*/5 * * * * dispatches recommend.yml when Supabase can't be reached", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith(ENV.SUPABASE_URL)) throw new Error("network down");
    calls.push(url);
    return fakeResponse(204);
  };
  try {
    await worker.scheduled({ cron: CRON.RECOMMEND, scheduledTime: Date.now() }, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.includes(`${GITHUB_API}/repos/${REPO}/actions/workflows/recommend.yml/dispatches`));
});
