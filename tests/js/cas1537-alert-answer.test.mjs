// CAS-1537: the alert-answer edge function (its core.ts, run here exactly as Deno runs it), the confirmation page
// that calls it, and the app's view of a recorded email tap. Tokens are minted by the monitor's own Python signer,
// so this also proves the Python and TypeScript halves agree on the token format.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { loadEngine } from "./engine.mjs";

const { handleAnswer, verifyToken, LABELS } = await import("../../supabase/functions/alert-answer/core.ts");

const SECRET = "cas1537-secret";
const NOW = 1_800_000_000;                       // epoch seconds
const U = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const KEYS = ["in_cinema", "premium", "rent", "stream", "never", "wow", "liked", "enjoyed", "soso", "disliked"];

function mint(key, { user = U, row = ROW, film = "603", now = NOW } = {}) {
  return execFileSync("python", ["-c",
    "import sys; from monitor.answer_links import sign_token; print(sign_token(*sys.argv[1:6], now=float(sys.argv[6])))",
    SECRET, user, row, film, key, String(now)], { encoding: "utf8" }).trim();
}

// An in-memory Db that records every write the function makes.
function fakeDb({ rows } = {}) {
  const table = rows ?? { [ROW]: { id: ROW, user_id: U, movie_id: "603", batch_id: BATCH, title: "The Matrix" } };
  const log = [];
  return {
    log,
    async getRow(id, userId) { const r = table[id]; return r && r.user_id === userId ? r : null; },
    async recordAnswer(rowId, userId, key, at) { log.push(["answer", rowId, userId, key, at]); },
    async upsertFilmWatch(row) { log.push(["film_watch", row]); },
    async deleteFilmWatch(userId, movieId) { log.push(["film_watch_delete", userId, movieId]); },
    async upsertUserFilm(row) { log.push(["user_films", row]); },
  };
}
const run = (method, body, db, nowSec = NOW + 3600) =>
  handleAnswer(method, body, { secret: SECRET, now: () => new Date(nowSec * 1000), db });

test("CAS-1537: a token minted in Python verifies here; a changed field or later time does not", async () => {
  const t = mint("rent");
  assert.deepEqual(await verifyToken(SECRET, t, NOW + 1), { u: U, r: ROW, f: "603", k: "rent", e: NOW + 30 * 86400 });
  assert.equal(await verifyToken("other", t, NOW + 1), null);
  assert.equal(await verifyToken(SECRET, t, NOW + 30 * 86400), null, "expired");
  const [v, body, sig] = t.split(".");
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...p, k: "never" })).toString("base64url");
  assert.equal(await verifyToken(SECRET, `${v}.${forged}.${sig}`, NOW + 1), null);
});

test("CAS-1537 AC4: a valid POST records answer/answered_at and the matching state, for every one of the ten keys", async () => {
  for (const key of KEYS) {
    const db = fakeDb();
    const out = await run("POST", { token: mint(key) }, db);
    assert.equal(out.status, 200, key);
    assert.deepEqual(out.body, { ok: true, label: LABELS[key], title: "The Matrix", film: "603", batch: BATCH });
    const at = new Date((NOW + 3600) * 1000).toISOString();
    assert.deepEqual(db.log.at(-1), ["answer", ROW, U, key, at], "the batch row carries answer + answered_at last");
    const state = db.log.slice(0, -1);
    if (["in_cinema", "premium", "rent", "stream"].includes(key)) {
      assert.deepEqual(state, [["film_watch", { user_id: U, movie_id: "603", windows: [key], sources: { [key]: "manual" } }]]);
    } else if (key === "never") {
      assert.deepEqual(state, [["film_watch_delete", U, "603"], ["user_films", { user_id: U, movie_id: "603", status: "notfor" }]]);
    } else {
      assert.deepEqual(state, [["user_films", { user_id: U, movie_id: "603", status: key }]]);
    }
  }
});

test("CAS-1537 AC4: an invalid or expired token records nothing", async () => {
  const good = mint("rent");
  const cases = [
    ["expired", good, NOW + 31 * 86400],
    ["tampered", good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA"), NOW + 3600],
    ["empty", "", NOW + 3600],
    ["wrong member's row", mint("rent", { user: "99999999-9999-4999-8999-999999999999" }), NOW + 3600],
    ["wrong film for the row", mint("rent", { film: "604" }), NOW + 3600],
    ["unknown row", mint("rent", { row: "44444444-4444-4444-8444-444444444444" }), NOW + 3600],
  ];
  for (const [name, token, at] of cases) {
    const db = fakeDb();
    const out = await run("POST", { token }, db, at);
    assert.equal(out.status, 400, name);
    assert.equal(out.body.error, "expired", name);
    assert.deepEqual(db.log, [], `${name} must record nothing`);
  }
  const db = fakeDb();
  assert.equal((await run("POST", {}, db)).status, 400);
  assert.equal((await run("POST", null, db)).status, 400);
  assert.deepEqual(db.log, []);
});

test("CAS-1537 AC4: a GET (a link scanner) records nothing", async () => {
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const db = fakeDb();
    const out = await run(method, { token: mint("rent") }, db);
    assert.equal(out.status, 405, method);
    assert.deepEqual(db.log, [], method);
  }
});

test("CAS-1537 last tap wins: a second tap on the same row simply overwrites", async () => {
  const db = fakeDb();
  await run("POST", { token: mint("rent") }, db);
  await run("POST", { token: mint("stream") }, db, NOW + 7200);
  const answers = db.log.filter(l => l[0] === "answer");
  assert.deepEqual(answers.map(a => a[3]), ["rent", "stream"]);
});

// ---- the confirmation page (a/index.html) ----------------------------------------------------------------
function runPage(search, db) {
  const html = fs.readFileSync(new URL("../../a/index.html", import.meta.url), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  const els = { msg: { textContent: "Saving…" }, open: { href: "/" } };
  const calls = [];
  const ctx = {
    document: { getElementById: id => els[id] },
    location: { search },
    URLSearchParams,
    window: { CASCADE_CONFIG: { SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "anon" } },
    encodeURIComponent,
    JSON,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const out = await run(init.method, JSON.parse(init.body), db);
      return { json: async () => out.body };
    },
  };
  vm.runInNewContext(script, ctx);
  return new Promise(resolve => setTimeout(() => resolve({ els, calls }), 20));
}

test("CAS-1537 AC6: the page shows 'Saved: <button label> for <title>' and opens the batch film", async () => {
  const db = fakeDb();
  const { els, calls } = await runPage(`?t=${mint("rent")}&src=email`, db);
  assert.equal(els.msg.textContent, "Saved: Rent for The Matrix");
  assert.equal(els.open.href, `/?dl=alerts:batch:${BATCH}&film=603`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://p.supabase.co/functions/v1/alert-answer");
  assert.equal(calls[0].init.method, "POST");
  const watched = await runPage(`?t=${mint("liked")}`, fakeDb());
  assert.equal(watched.els.msg.textContent, "Saved: Watch Again for The Matrix");
});

test("CAS-1537 AC6: an expired or missing token says so in one line and still offers Open in Cascade", async () => {
  const db = fakeDb();
  const expired = await runPage(`?t=${mint("rent", { now: NOW - 40 * 86400 })}`, db);
  assert.equal(expired.els.msg.textContent, "This link has expired.");
  assert.equal(expired.els.open.href, "/");
  const none = await runPage("", db);
  assert.equal(none.els.msg.textContent, "This link has expired.");
  assert.equal(none.calls.length, 0, "no token, no request");
  assert.deepEqual(db.log, []);
  const html = fs.readFileSync(new URL("../../a/index.html", import.meta.url), "utf8");
  assert.match(html, />Open in Cascade</);
  assert.ok(!/innerHTML/.test(html), "the page writes text only");
});

// ---- the app's side: the film leaves To decide, the button shows selected ------------------------------
test("CAS-1537 AC5: after a recorded email tap the film leaves To decide and the batch view shows the button selected", async () => {
  const E = loadEngine();
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && E.watchLevelsFor(x.tmdb_id).some(l => !l.spent && E.windowEnabled(l.key)));
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent && E.windowEnabled(l.key)).key;
  const film = String(m.tmdb_id);
  const other = E.MOVIES.find(x => x.tmdb_id !== m.tmdb_id && !E.watched.has(x.tmdb_id));
  const cp = E.window.CascadePersistence, savedActive = cp.accountActive;
  cp.accountActive = () => true;
  try {
    const batches = answer => [{ id: BATCH, sydney_date: E.sydneyYMD(Date.now()), headline: "h",
      films: [{ movie_id: film, answer }, { movie_id: String(other.tmdb_id), answer: null }] }];
    const guestSafe = () => E.localStorage.setItem("cascade_had_account", "1");
    guestSafe();
    E.setAlertBatches(batches(null));
    assert.equal(E.toDecideCount(), 2);

    // The email tap, exactly as the function records it (the rows it writes, applied the way the app loads them).
    const db = fakeDb({ rows: { [ROW]: { id: ROW, user_id: U, movie_id: film, batch_id: BATCH, title: m.title } } });
    const out = await run("POST", { token: mint(level, { film }) }, db);
    assert.equal(out.status, 200);
    const fw = db.log.find(l => l[0] === "film_watch")[1];
    const ans = db.log.find(l => l[0] === "answer");
    E.CascadePersistence.applyWatchRows([{ movie_id: fw.movie_id, windows: fw.windows, sources: fw.sources, updated_at: ans[4] }]);
    E.setAlertBatches(batches(ans[3]));                       // notifications.answer, as loadAlertBatches reads it
    assert.equal(E.toDecideCount(), 1, "the answered film no longer counts");
    assert.match(E.batchControlsHTML({ m }), new RegExp(`cseg on[^"]*" data-key="${level}"`), "the Watch On button shows selected");

    // A Watched tap: user_films row -> the Watched button is selected too.
    const db2 = fakeDb({ rows: { [ROW]: { id: ROW, user_id: U, movie_id: String(other.tmdb_id), batch_id: BATCH, title: other.title } } });
    const out2 = await run("POST", { token: mint("wow", { film: String(other.tmdb_id) }) }, db2);
    assert.equal(out2.status, 200);
    const uf = db2.log.find(l => l[0] === "user_films")[1];
    E.CascadePersistence.applyFilmRows([{ user_id: uf.user_id, movie_id: uf.movie_id, status: uf.status }]);
    E.setAlertBatches([{ id: BATCH, sydney_date: E.sydneyYMD(Date.now()), headline: "h",
      films: [{ movie_id: film, answer: ans[3] }, { movie_id: String(other.tmdb_id), answer: "wow" }] }]);
    assert.equal(E.toDecideCount(), 0);
    assert.match(E.batchControlsHTML({ m: other }), /cseg on[^"]*" data-key="wow"/);
  } finally {
    cp.accountActive = savedActive;
    E.setAlertBatches([]);
  }
});
