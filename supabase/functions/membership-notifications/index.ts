// CAS-971: membership-notifications — the App Store Server Notifications V2 endpoint. Apple POSTs
// {"signedPayload": "<JWS>"}; we verify it (and the nested signedTransactionInfo) and update the matching
// public.memberships row: renewals, expiries, refunds, revocations, billing retry / grace. NOT deployed by
// the worker (Lee-gated). Deploy with --no-verify-jwt (Apple sends no Supabase JWT) and set this function's
// URL as the Production AND Sandbox "App Store Server Notifications URL" (Version 2) in App Store Connect.
// Secrets/config: APPLE_BUNDLE_ID, APPLE_PRODUCT_ID, optional APPLE_ROOT_CA_G3_SHA256 (as membership-verify).
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  entitlementFromTransaction, statusForNotification, verifyAppleJws, type TransactionInfo,
} from "../_shared/apple.ts";

interface Notification {
  notificationType: string;
  subtype?: string;
  data?: { bundleId?: string; signedTransactionInfo?: string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const opts = { rootFingerprint: Deno.env.get("APPLE_ROOT_CA_G3_SHA256") || undefined };
  const bundleId = Deno.env.get("APPLE_BUNDLE_ID") || "au.com.codynamics.cascade";
  const productId = Deno.env.get("APPLE_PRODUCT_ID") || "au.com.codynamics.cascade.membership.monthly";

  let note: Notification, ent;
  try {
    const { signedPayload } = await req.json();
    note = await verifyAppleJws<Notification>(signedPayload, opts);
    if (note.notificationType === "TEST" || !note.data?.signedTransactionInfo) return new Response("ok");
    const tx = await verifyAppleJws<TransactionInfo>(note.data.signedTransactionInfo, opts);
    ent = entitlementFromTransaction(tx, { bundleId, productId });
  } catch (e) {
    // 400 = a payload that does not verify is never retried-into-validity; transient faults are 500 below.
    return new Response(`invalid: ${(e as Error).message}`, { status: 400 });
  }

  const status = statusForNotification(note.notificationType, note.subtype) ?? ent.status;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Match on the original transaction id the verify function stored; comps are never touched.
  const { error } = await admin.from("memberships").update({
    status,
    expires_at: ent.expires_at,
    is_trial: ent.is_trial,
    updated_at: new Date().toISOString(),
  }).eq("original_transaction_id", ent.original_transaction_id).eq("source", "apple");
  if (error) return new Response(error.message, { status: 500 });
  return new Response("ok");
});
