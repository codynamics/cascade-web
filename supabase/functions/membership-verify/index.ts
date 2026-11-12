// CAS-971: membership-verify — the app posts the signed StoreKit 2 transaction (JWS) here right after a
// purchase or a restore. We verify it against Apple's certificate chain and upsert the caller's
// public.memberships row. NOT deployed by the worker (Lee-gated) — see the CAS-971 completion comment.
//
// Secrets/config (supabase secrets set ...): APPLE_BUNDLE_ID=au.com.codynamics.cascade
//   APPLE_PRODUCT_ID=au.com.codynamics.cascade.membership.monthly (default shown), optional
//   APPLE_ROOT_CA_G3_SHA256. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";
import { entitlementFromTransaction, verifyAppleJws, type TransactionInfo } from "../_shared/apple.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(token);
  const user = who?.user;
  if (!user) return json({ error: "unauthenticated" }, 401);

  let signed: string;
  try { signed = (await req.json()).signedTransaction; } catch { return json({ error: "bad body" }, 400); }

  let ent;
  try {
    const tx = await verifyAppleJws<TransactionInfo>(signed, {
      rootFingerprint: Deno.env.get("APPLE_ROOT_CA_G3_SHA256") || undefined,
    });
    ent = entitlementFromTransaction(tx, {
      bundleId: Deno.env.get("APPLE_BUNDLE_ID") || "au.com.codynamics.cascade",
      productId: Deno.env.get("APPLE_PRODUCT_ID") || "au.com.codynamics.cascade.membership.monthly",
    });
  } catch (e) {
    return json({ error: "invalid transaction", detail: String((e as Error).message) }, 400);
  }
  // A transaction already bound to a different Cascade account (appAccountToken) is not this caller's.
  if (ent.app_account_token && ent.app_account_token.toLowerCase() !== user.id.toLowerCase()) {
    return json({ error: "transaction belongs to another account" }, 403);
  }
  // Never let an Apple transaction overwrite a hand-granted comp.
  const { data: existing } = await admin.from("memberships").select("source").eq("user_id", user.id).maybeSingle();
  if (existing?.source === "comp") return json({ ok: true, status: "active", source: "comp" });

  const { error } = await admin.from("memberships").upsert({
    user_id: user.id,
    original_transaction_id: ent.original_transaction_id,
    product_id: ent.product_id,
    status: ent.status,
    expires_at: ent.expires_at,
    is_trial: ent.is_trial,
    source: "apple",
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) return json({ error: "db", detail: error.message }, 500);
  return json({ ok: true, status: ent.status, expires_at: ent.expires_at, is_trial: ent.is_trial });
});
