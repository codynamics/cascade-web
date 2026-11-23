import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker, {
  CRON,
  GITHUB_API,
  RESEND_API,
  REPO,
  RETRY_DELAY_MS,
  UNSENT_MAIL_CHECKS,
  sydneyClock,
  dispatchesForTick,
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

const AEDT = "2026-11-22"; // Sydney is UTC+11 (the Sydney day starts the previous UTC day at 13:00)
const AEST = "2026-07-15"; // Sydney is UTC+10

// ISO instant for Sydney local HH:MM on the given Sydney date, using the fixed offset for that date.
function sydneyInstant(date, hh, mm, offsetHours) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh - offsetHours, mm);
}

const SIDES = [
  { name: "AEDT", date: AEDT, offset: 11 },
  { name: "AEST", date: AEST, offset: 10 },
];

function labels(epochMs) {
  return dispatchesForTick(epochMs).map((d) => (d.inputs ? `${d.workflow}:${d.inputs.phase}` : d.workflow));
}

test("wrangler.toml declares exactly one cron, */5 * * * *", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = toml.match(/^crons\s*=\s*\[([^\]]*)\]/m);
  assert.ok(crons);
  const entries = [...crons[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(entries, ["*/5 * * * *"]);
  assert.equal(CRON.TICK, "*/5 * * * *");
});

test("sydneyClock gives the Sydney hour and minute on both sides of DST", () => {
  assert.deepEqual(sydneyClock(Date.parse("2026-11-22T14:00:00Z")), { hour: 1, minute: 0 });
  assert.deepEqual(sydneyClock(Date.parse("2026-07-15T15:00:00Z")), { hour: 1, minute: 0 });
  assert.deepEqual(sydneyClock(Date.parse("2026-11-22T20:34:00Z")), { hour: 7, minute: 34 });
});

for (const { name, date, offset } of SIDES) {
  const at = (hh, mm) => sydneyInstant(date, hh, mm, offset);

  test(`${name}: 01:00-01:04 dispatches daily.yml once; 00:55 and 01:05 do not`, () => {
    assert.deepEqual(labels(at(1, 0)), ["daily.yml"]);
    assert.deepEqual(labels(at(1, 5)), []);
    assert.deepEqual(labels(at(0, 55)), []);
  });

  test(`${name}: 03:00 dispatches alerts.yml phase=find once; 02:55 and 03:05 do not`, () => {
    assert.deepEqual(labels(at(3, 0)), ["alerts.yml:find"]);
    assert.deepEqual(labels(at(3, 5)), []);
    assert.deepEqual(labels(at(2, 55)), []);
  });

  test(`${name}: 07:30 dispatches alerts.yml phase=push once; 07:25 and 07:35 do not`, () => {
    assert.deepEqual(labels(at(7, 30)), ["alerts.yml:push"]);
    assert.deepEqual(labels(at(7, 25)), []);
    assert.deepEqual(labels(at(7, 35)), []);
    assert.deepEqual(labels(at(7, 0)), []);
  });

  test(`${name}: 17:00 dispatches alerts.yml phase=email once; 16:55 and 17:05 do not`, () => {
    assert.deepEqual(labels(at(17, 0)), ["alerts.yml:email"]);
    assert.deepEqual(labels(at(17, 5)), []);
    assert.deepEqual(labels(at(16, 55)), []);
  });

  test(`${name}: uptime.yml dispatches once per hour, on the minute 15-19 tick only`, () => {
    for (const hh of [0, 5, 9, 13, 22]) {
      let count = 0;
      for (let mm = 0; mm < 60; mm += 5) if (labels(at(hh, mm)).includes("uptime.yml")) count += 1;
      assert.equal(count, 1, `hour ${hh}`);
      assert.deepEqual(labels(at(hh, 15)), ["uptime.yml"]);
    }
  });

  test(`${name}: every tick of the day dispatches at most the four daily jobs plus hourly uptime`, () => {
    const tally = {};
    for (let hh = 0; hh < 24; hh++) {
      for (let mm = 0; mm < 60; mm += 5) {
        for (const l of labels(at(hh, mm))) tally[l] = (tally[l] || 0) + 1;
      }
    }
    assert.deepEqual(tally, {
      "daily.yml": 1,
      "alerts.yml:find": 1,
      "alerts.yml:push": 1,
      "alerts.yml:email": 1,
      "uptime.yml": 24,
    });
  });
}

test("the scheduled handler dispatches alerts.yml phase=push at 07:30 AEDT only, with the exact body", async () => {
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.startsWith(ENV.SUPABASE_URL)) return fakeJsonResponse(200, []);
    hits.push({ url, body: init.body });
    return fakeResponse(204);
  };
  try {
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T20:30:00Z") }, ENV);
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T20:35:00Z") }, ENV);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(hits.length, 1);
  assert.match(hits[0].url, /workflows\/alerts\.yml\/dispatches$/);
  assert.equal(hits[0].body, JSON.stringify({ ref: "main", inputs: { phase: "push" } }));
});

test("one tick can dispatch uptime and recommend together", async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith(ENV.SUPABASE_URL)) return fakeJsonResponse(200, [{ id: 1 }]);
    urls.push(url);
    return fakeResponse(204);
  };
  try {
    // 2026-11-22T05:15Z = 16:15 AEDT
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T05:15:00Z") }, ENV);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(urls, [
    `${GITHUB_API}/repos/${REPO}/actions/workflows/uptime.yml/dispatches`,
    `${GITHUB_API}/repos/${REPO}/actions/workflows/recommend.yml/dispatches`,
  ]);
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
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T05:07:00Z") }, ENV);
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
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T05:07:00Z") }, ENV);
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
    await worker.scheduled({ cron: CRON.TICK, scheduledTime: Date.parse("2026-11-22T05:07:00Z") }, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.includes(`${GITHUB_API}/repos/${REPO}/actions/workflows/recommend.yml/dispatches`));
});
