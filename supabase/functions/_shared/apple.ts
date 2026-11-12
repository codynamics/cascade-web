// CAS-971: verification of Apple's signed JWS payloads (StoreKit 2 transactions, App Store Server
// Notifications V2). Pure functions, no network — Apple's x5c chain is carried inside every JWS header.
// Trust is anchored by PINNING the SHA-256 fingerprint of Apple Root CA - G3 (override with the
// APPLE_ROOT_CA_G3_SHA256 secret if Apple ever rotates it). Lee: confirm the fingerprint below against
// https://www.apple.com/certificateauthority/ (AppleRootCA-G3.cer) before deploying.
import { X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";

export const APPLE_ROOT_CA_G3_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

const b64urlToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export interface VerifyOptions { rootFingerprint?: string; now?: Date }

/** Verifies a JWS signed by Apple and returns its decoded payload. Throws on any failure. */
export async function verifyAppleJws<T = Record<string, unknown>>(jws: string, opts: VerifyOptions = {}): Promise<T> {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("not a JWS");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (header.alg !== "ES256") throw new Error("unexpected alg");
  const chain: string[] = header.x5c;
  if (!Array.isArray(chain) || chain.length < 2) throw new Error("missing x5c chain");
  const certs = chain.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  const now = opts.now ?? new Date();

  for (const c of certs) {
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) throw new Error("certificate outside validity");
  }
  // each certificate is signed by the next one up; the last must be Apple's pinned root
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) throw new Error("broken certificate chain");
  }
  const root = certs[certs.length - 1];
  const pinned = (opts.rootFingerprint || APPLE_ROOT_CA_G3_SHA256).replace(/:/g, "").toLowerCase();
  if (root.fingerprint256.replace(/:/g, "").toLowerCase() !== pinned) throw new Error("untrusted root");
  if (!root.verify(root.publicKey)) throw new Error("root is not self-signed");

  const key = await crypto.subtle.importKey(
    "spki",
    certs[0].publicKey.export({ type: "spki", format: "der" }) as Uint8Array,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("bad signature");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
}

export interface TransactionInfo {
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  environment?: string;
  expiresDate?: number;          // ms since epoch
  revocationDate?: number;
  offerType?: number;            // 1 = introductory offer (the free trial)
  appAccountToken?: string;
}

export interface Entitlement {
  original_transaction_id: string;
  product_id: string;
  status: "active" | "expired" | "revoked";
  expires_at: string;
  is_trial: boolean;
  app_account_token: string | null;
}

/** Pure: a verified transaction payload -> the row fields. Rejects another app's / product's transaction. */
export function entitlementFromTransaction(
  tx: TransactionInfo,
  cfg: { bundleId: string; productId: string; now?: Date },
): Entitlement {
  if (tx.bundleId !== cfg.bundleId) throw new Error("wrong bundle");
  if (tx.productId !== cfg.productId) throw new Error("wrong product");
  if (!tx.expiresDate) throw new Error("no expiry");
  const now = (cfg.now ?? new Date()).getTime();
  const status = tx.revocationDate ? "revoked" : tx.expiresDate > now ? "active" : "expired";
  return {
    original_transaction_id: tx.originalTransactionId,
    product_id: tx.productId,
    status,
    expires_at: new Date(tx.expiresDate).toISOString(),
    is_trial: tx.offerType === 1,
    app_account_token: tx.appAccountToken ?? null,
  };
}

/** Pure: maps a V2 notification type to the status override it implies (null = take it from the transaction). */
export function statusForNotification(type: string, subtype?: string): "revoked" | "expired" | "grace" | "billing_retry" | null {
  if (type === "REFUND" || type === "REVOKE") return "revoked";
  if (type === "EXPIRED") return "expired";
  if (type === "GRACE_PERIOD_EXPIRED") return "expired";
  if (type === "DID_FAIL_TO_RENEW") return subtype === "GRACE_PERIOD" ? "grace" : "billing_retry";
  return null;   // SUBSCRIBED / DID_RENEW / DID_CHANGE_RENEWAL_STATUS (cancel keeps access to expiry) / ...
}
