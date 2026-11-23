// CAS-1537: alert-answer - records a one-tap Watch On / Watched answer from an alert email. The static page
// https://cascademovies.com/a/ POSTs {token} here; core.ts verifies the signed token and records the tap.
// A GET (a link scanner, a prefetch) records nothing. The member has no session, so the page sends the public
// anon key as the bearer (the gateway's JWT check); the HMAC token is the only authority.
//
// Secrets (supabase secrets set ...): ALERT_ANSWER_SECRET (same value as the monitor's GitHub environment
// secret). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. NOT deployed by the worker
// (Lee-gated) - .github/workflows/deploy-functions.yml lists it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, handleAnswer } from "./core.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const must = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };
  const db: Db = {
    async getRow(id, userId) {
      const { data, error } = await admin.from("notifications").select("id,movie_id,batch_id,title").eq("id", id).eq("user_id", userId).maybeSingle();
      must(error);
      return data;
    },
    async recordAnswer(rowId, userId, key, at) {
      must((await admin.from("notifications").update({ answer: key, answered_at: at }).eq("id", rowId).eq("user_id", userId)).error);
    },
    async upsertFilmWatch(row) {
      must((await admin.from("film_watch").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,movie_id" })).error);
    },
    async deleteFilmWatch(userId, movieId) {
      must((await admin.from("film_watch").delete().eq("user_id", userId).eq("movie_id", movieId)).error);
    },
    async upsertUserFilm(row) {
      must((await admin.from("user_films").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,movie_id" })).error);
    },
  };
  let body: unknown = null;
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  let out;
  try {
    out = await handleAnswer(req.method, body, { secret: Deno.env.get("ALERT_ANSWER_SECRET") || "", now: () => new Date(), db });
  } catch (_e) {
    out = { status: 500, body: { ok: false, error: "db" } };
  }
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...CORS, "Content-Type": "application/json" } });
});
