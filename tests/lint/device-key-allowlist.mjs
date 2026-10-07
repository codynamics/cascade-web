// CAS-1221: static check over app_template.html's own DEVICE_KEY_ALLOWLIST — the single source of truth
// for every localStorage/sessionStorage key this app may write. Fails `npm run test:lint` if a
// localStorage.setItem/sessionStorage.setItem call's key cannot be proven to be in that allowlist.
//
// A key argument is resolved statically, three ways:
//   1. A quoted string literal ("cascade_foo") — checked against the allowlist directly.
//   2. A bare identifier (NOTIFY_KEY, CLIENT_KEY_STORE, ...) — resolved by finding that identifier's own
//      `= "literal"` assignment elsewhere in the file (how every *_KEY constant in this file is declared),
//      then checked the same way.
//   3. The literal call `opQueueKey()` — acctOp's own per-account queue key (cascade_ops@<uid>) is the one
//      deliberately dynamic key this app writes; allowed only when the allowlist carries its own
//      "cascade_ops@" prefix entry, so removing that entry here would also break this check.
// Anything else (a template literal, string concatenation, a parameter) fails as unresolvable — the point
// of this check is that every write stays statically provable, not merely "probably fine".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "app_template.html");

function extractAllowlist(html) {
  const start = html.indexOf("const DEVICE_KEY_ALLOWLIST");
  if (start === -1) throw new Error("no DEVICE_KEY_ALLOWLIST constant found in app_template.html");
  const braceOpen = html.indexOf("{", start);
  let depth = 1, i = braceOpen + 1;
  while (i < html.length && depth > 0) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") depth--;
    i++;
  }
  const body = html.slice(braceOpen + 1, i - 1);
  const keys = new Set();
  const keyRe = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let m;
  while ((m = keyRe.exec(body))) keys.add(m[1]);
  return keys;
}

// Every `IDENT = "literal"` assignment in the file (const/let/multi-declarator lists all match this same
// shape) — used to resolve a bare identifier passed as a setItem key back to its string value.
function buildIdentifierMap(html) {
  const map = new Map();
  const re = /([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html))) map.set(m[1], m[2]);
  return map;
}

// Captures the first argument of a call starting right after `(` at `openParen`, respecting nested
// parens/brackets/braces and quoted strings, stopping at the first top-level comma or the closing paren.
function firstArg(html, openParen) {
  let depth = 0, i = openParen, buf = "";
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && ch === ",") break;
    else if (ch === '"' || ch === "'") {
      const quote = ch;
      buf += ch;
      i++;
      while (i < html.length && html[i] !== quote) { buf += html[i]; i++; }
      buf += html[i] ?? "";
      continue;
    }
    buf += ch;
  }
  return buf.trim();
}

function lineAt(html, offset) {
  return (html.slice(0, offset).match(/\n/g) || []).length + 1;
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");
  const allowlist = extractAllowlist(html);
  const idents = buildIdentifierMap(html);
  const hasOpsPrefix = [...allowlist].some(k => k.indexOf("cascade_ops@") === 0);

  const callRe = /\b(localStorage|sessionStorage)\.setItem\s*\(/g;
  const violations = [];
  let m;
  while ((m = callRe.exec(html))) {
    const afterParen = m.index + m[0].length;
    const arg = firstArg(html, afterParen);
    const line = lineAt(html, m.index);
    const literalMatch = /^(["'])((?:[^"'\\]|\\.)*)\1$/.exec(arg);

    if (literalMatch) {
      const key = literalMatch[2];
      if (!allowlist.has(key)) {
        violations.push(`${line}: ${m[1]}.setItem("${key}", ...) — "${key}" is not in DEVICE_KEY_ALLOWLIST`);
      }
      continue;
    }
    if (arg === "opQueueKey()") {
      if (!hasOpsPrefix) {
        violations.push(`${line}: ${m[1]}.setItem(opQueueKey(), ...) — DEVICE_KEY_ALLOWLIST carries no "cascade_ops@" prefix entry`);
      }
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(arg) && idents.has(arg)) {
      const key = idents.get(arg);
      if (!allowlist.has(key)) {
        violations.push(`${line}: ${m[1]}.setItem(${arg}, ...) — ${arg} resolves to "${key}", not in DEVICE_KEY_ALLOWLIST`);
      }
      continue;
    }
    violations.push(`${line}: ${m[1]}.setItem(${arg}, ...) — key is not a literal, a resolvable constant, or opQueueKey(); cannot verify against DEVICE_KEY_ALLOWLIST`);
  }

  for (const v of violations) console.error(`[device-key-allowlist] app_template.html:${v}`);
  console.log(`\ndevice-key-allowlist: ${violations.length} violation(s), ${allowlist.size} key(s) allowlisted`);
  if (violations.length) process.exit(1);
}

run();
