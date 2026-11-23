// CAS-1537: the logic of the alert-answer edge function, free of Deno/Supabase globals so node can test it
// (tests/js/cas1537-alert-answer.test.mjs) exactly as Deno runs it. index.ts is the thin Deno wrapper.
//
// The token format is monitor/answer_links.py's (read its header): "v1.<b64url payload>.<b64url HMAC-SHA256>",
// payload {u: member, r: notifications row id, f: film id, k: button key, e: expiry epoch s}. Secret:
// ALERT_ANSWER_SECRET (function secret; the monitor holds the same value as a GitHub environment secret).
import DEFS from "../_shared/answer_keys.json" with { type: "json" };

type Def = { key: string; label: string };
const WATCH_ON_KEYS = ["in_cinema", "premium", "rent", "stream"]; // the four windows; "never" is its own branch
const ALL: Def[] = [...(DEFS.watch_on as Def[]), ...(DEFS.watched as Def[])];
export const LABELS: Record<string, string> = Object.fromEntries(ALL.map((d) => [d.key, d.label]));

export type Payload = { u: string; r: string; f: string; k: string; e: number };

export interface Db {
  // The member's own notifications row (batch row), or null.
  getRow(id: string, userId: string): Promise<{ id: string; movie_id: string; batch_id: string | null; title: string } | null>;
  recordAnswer(rowId: string, userId: string, key: string, at: string): Promise<void>;
  upsertFilmWatch(row: { user_id: string; movie_id: string; windows: string[]; sources: Record<string, string> }): Promise<void>;
  deleteFilmWatch(userId: string, movieId: string): Promise<void>;
  upsertUserFilm(row: { user_id: string; movie_id: string; status: string }): Promise<void>;
}

const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// The payload when the signature holds, the key is one of the ten and the token has not expired; else null.
export async function verifyToken(secret: string, token: unknown, nowSec: number): Promise<Payload | null> {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !secret) return null;
    const expected = await hmac(secret, `${parts[0]}.${parts[1]}`);
    if (!sameBytes(expected, unb64u(parts[2]))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
    if (!(p.k in LABELS) || !["u", "r", "f"].every((x) => typeof p[x] === "string" && p[x])) return null;
    if (!(nowSec < Number(p.e))) return null;
    return p as Payload;
  } catch {
    return null;
  }
}

export type Result = { status: number; body: Record<string, unknown> };

// POST {token}: verify, then record exactly what the app's batch view records for the same tap (CAS-1536):
//   Watch On window -> film_watch {windows:[key], sources:{key:"manual"}}   (toggleFilmOpt, SET not toggle)
//   never           -> film_watch row cleared + user_films status "notfor"  (pickNever)
//   Watched key     -> user_films status = key                               (setOpinion)
// and notifications.answer = key, answered_at = now on that batch row. Last tap wins. Any other method, or an
// invalid/expired token, records nothing.
export async function handleAnswer(
  method: string,
  body: unknown,
  deps: { secret: string; now: () => Date; db: Db },
): Promise<Result> {
  if (method !== "POST") return { status: 405, body: { ok: false, error: "method" } };
  const token = body && typeof body === "object" ? (body as Record<string, unknown>).token : undefined;
  const p = await verifyToken(deps.secret, token, deps.now().getTime() / 1000);
  if (!p) return { status: 400, body: { ok: false, error: "expired" } };
  const row = await deps.db.getRow(p.r, p.u);
  if (!row || String(row.movie_id) !== p.f) return { status: 400, body: { ok: false, error: "expired" } };
  const at = deps.now().toISOString();
  if (WATCH_ON_KEYS.includes(p.k)) {
    await deps.db.upsertFilmWatch({ user_id: p.u, movie_id: p.f, windows: [p.k], sources: { [p.k]: "manual" } });
  } else if (p.k === "never") {
    await deps.db.deleteFilmWatch(p.u, p.f);
    await deps.db.upsertUserFilm({ user_id: p.u, movie_id: p.f, status: "notfor" });
  } else {
    await deps.db.upsertUserFilm({ user_id: p.u, movie_id: p.f, status: p.k });
  }
  await deps.db.recordAnswer(p.r, p.u, p.k, at);
  return { status: 200, body: { ok: true, label: LABELS[p.k], title: row.title, film: p.f, batch: row.batch_id } };
}
