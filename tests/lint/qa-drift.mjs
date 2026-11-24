// CAS-1556: QA drift check. QA cases live in qa/cases/*.yaml beside the code; this fails the push gate
// when a case (or the code it describes) goes stale:
//   R1  a case's refs name an element id (#id), a function (name()) that is not in app_template.html, or a
//       file that does not exist;
//   R2  a TOURS step's `sel` has an #id or .class that is not in app_template.html;
//   R3  a TOURS key (tour:<key>), a monitor/transitions.py MOMENTS value (moment:<m>), a digest kind passed to
//       render_digest (digest:<kind>) or a top-level *Screen element id (#xScreen) is named by no case;
//   R4  a tests/e2e/*.spec.mjs file is named by no case;
//   R5  qa/RELEASE-CHECKLIST.md differs from a fresh `python qa/build_checklist.py` build.
// Ref forms: `#id`, `fn()`, `tour:x`, `moment:x`, `digest:x`, or a repo-relative file path (contains `/`).
// Exports runChecks() for tests/js/qa-drift.test.mjs; run directly: `node tests/lint/qa-drift.mjs`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- cases: a deliberately tiny YAML subset (list of maps; scalar or list-of-scalar values) -------------
export function parseScalar(s) {
  s = s.trim();
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function parseCases(text, file = "?") {
  const cases = [];
  let cur = null, listKey = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    const where = `${file}:${i + 1}`;
    let m;
    if ((m = raw.match(/^- (\w+):\s*(.*)$/))) {
      cur = { _file: file }; cases.push(cur); listKey = null; cur[m[1]] = parseScalar(m[2]);
    } else if ((m = raw.match(/^  (\w+):\s*(.*)$/)) && cur) {
      if (m[2] === "") { cur[m[1]] = []; listKey = m[1]; } else { cur[m[1]] = parseScalar(m[2]); listKey = null; }
    } else if ((m = raw.match(/^    - (.*)$/)) && cur && listKey) {
      cur[listKey].push(parseScalar(m[1]));
    } else throw new Error(`${where}: cannot parse case line: ${raw}`);
  });
  return cases;
}

export function loadCases(root = ROOT) {
  const dir = path.join(root, "qa", "cases");
  return readdirSync(dir).filter(f => f.endsWith(".yaml")).sort()
    .flatMap(f => parseCases(readFileSync(path.join(dir, f), "utf8"), `qa/cases/${f}`));
}

// ---- extractors ------------------------------------------------------------------------------------------
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function hasId(app, id) {
  // id="x" / id:"x", or an id passed to the settings-sheet section builder: sec("key", "x", ...)
  return new RegExp(`\\bid\\s*=\\s*\\\\?["']${esc(id)}\\\\?["']|\\bid\\s*:\\s*["']${esc(id)}["']|\\bsec\\(\\s*["'][\\w-]+["']\\s*,\\s*["']${esc(id)}["']`).test(app);
}
export function hasFunction(app, name) {
  const n = esc(name);
  return new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(|\\b(?:const|let|var)\\s+${n}\\b|\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)|\\bwindow\\.${n}\\s*=`).test(app);
}
export function hasClass(app, cls) {
  const c = esc(cls);
  return new RegExp(`\\.${c}(?![\\w-])`).test(app) || new RegExp(`class\\s*=\\s*\\\\?["'][^"']*(?<![\\w-])${c}(?![\\w-])`).test(app)
    || new RegExp(`classList\\.\\w+\\(\\s*["']${c}["']`).test(app);
}

// Selector tokens: strip [attr…] and quoted strings, then take #id / .class.
export function selectorTokens(sel) {
  const bare = sel.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"|'[^']*'/g, "");
  const out = [];
  for (const m of bare.matchAll(/([#.])([A-Za-z_][\w-]*)/g)) out.push({ kind: m[1] === "#" ? "id" : "class", name: m[2] });
  return out;
}

function toursBlock(app) {
  const a = app.indexOf("const TOURS = {");
  if (a < 0) throw new Error("TOURS not found in app_template.html");
  const b = app.indexOf("const V2_TOUR_STEPS", a);
  return app.slice(a, b < 0 ? undefined : b);
}
export function tourKeys(app) {
  return [...toursBlock(app).matchAll(/^  (\w+):\s*\{\s*title:/gm)].map(m => m[1]);
}
// Every `sel:[ "a", `b` ]` array in TOURS, bracket/quote aware (selectors contain [attr] and quotes).
export function tourSels(app) {
  const blk = toursBlock(app), out = [];
  for (const m of blk.matchAll(/\bsel\s*:\s*\[/g)) {
    let i = m.index + m[0].length, cur = null;
    const startTour = blk.lastIndexOf("\n  ", m.index);
    for (; i < blk.length; i++) {
      const ch = blk[i];
      if (cur !== null) { if (ch === "\\") i++; else if (ch === cur.q) { out.push(cur.s); cur = null; } else cur.s += ch; }
      else if (ch === '"' || ch === "'" || ch === "`") cur = { q: ch, s: "" };
      else if (ch === "]") break;
    }
  }
  return out;
}
export function momentValues(py) {
  const m = py.match(/^MOMENTS\s*=\s*\(([^)]*)\)/m);
  if (!m) throw new Error("MOMENTS not found in monitor/transitions.py");
  return [...m[1].matchAll(/"(\w+)"/g)].map(x => x[1]);
}
// Digest kinds: render_digest's default plus every string literal at the top level of a `kind=` argument
// of a render_digest( call, in the non-test monitor modules.
export function digestKinds(sources) {
  const kinds = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/def render_digest\([^)]*?kind\s*:\s*str\s*=\s*"(\w+)"/g)) kinds.add(m[1]);
    for (const m of src.matchAll(/(?<!def )\brender_digest\(/g)) {
      let depth = 1, i = m.index + m[0].length, inStr = null; const start = i;
      for (; i < src.length && depth; i++) {
        const ch = src[i];
        if (inStr) { if (ch === inStr) inStr = null; } else if (ch === '"' || ch === "'") inStr = ch;
        else if (ch === "(") depth++; else if (ch === ")") depth--;
      }
      const call = src.slice(start, i - 1);
      const k = call.match(/\bkind\s*=\s*/);
      if (!k) continue;
      let j = k.index + k[0].length, d = 0, expr = "", str = null;
      for (; j < call.length; j++) {
        const ch = call[j];
        if (str) { if (ch === str) str = null; if (d === 0) expr += ch; continue; }
        if (ch === '"' || ch === "'") { str = ch; if (d === 0) expr += ch; continue; }
        if (ch === "(") { d++; continue; }
        if (ch === ")") { d--; continue; }
        if (ch === "," && d === 0) break;
        if (d === 0) expr += ch;
      }
      for (const s of expr.matchAll(/"(\w+)"|'(\w+)'/g)) kinds.add(s[1] || s[2]);
    }
  }
  return [...kinds];
}
export function screenIds(app) {
  return [...new Set([...app.matchAll(/\bid="(\w+Screen)"/g)].map(m => m[1]))];
}

// ---- the checks ------------------------------------------------------------------------------------------
// inputs: { cases, app, transitionsPy, monitorSources[], e2eFiles[], fileExists(rel) }
export function runChecks(inp) {
  const v = [];
  const { cases, app } = inp;
  const named = new Set();
  const seenIds = new Set();
  for (const c of cases) {
    const at = `${c._file || "?"} ${c.id || "(no id)"}`;
    for (const k of ["id", "part", "title", "how"]) if (!c[k]) v.push(`[QA-DRIFT:CASE] ${at}: missing ${k}`);
    if (!Array.isArray(c.expect) || !c.expect.length) v.push(`[QA-DRIFT:CASE] ${at}: expect must list at least one line`);
    if (c.id) { if (seenIds.has(c.id)) v.push(`[QA-DRIFT:CASE] ${at}: duplicate id`); seenIds.add(c.id); }
    for (const ref of c.refs || []) {
      named.add(ref);
      if (ref.startsWith("#")) { if (!hasId(app, ref.slice(1))) v.push(`[QA-DRIFT:REF] ${at}: element id ${ref} is not in app_template.html`); }
      else if (/^[\w$.]+\(\)$/.test(ref)) { if (!hasFunction(app, ref.slice(0, -2))) v.push(`[QA-DRIFT:REF] ${at}: function ${ref} is not in app_template.html`); }
      else if (/^(tour|moment|digest):/.test(ref)) { /* coverage tag, checked in R3 against the code's own list */ }
      else if (ref.includes("/")) { if (!inp.fileExists(ref)) v.push(`[QA-DRIFT:REF] ${at}: file ${ref} does not exist`); }
      else v.push(`[QA-DRIFT:REF] ${at}: unrecognised ref form "${ref}"`);
    }
  }
  const tours = tourKeys(app);
  if (!tours.length) v.push("[QA-DRIFT:TOURS] no TOURS keys found - extractor out of date");
  // Search outside the TOURS block, or a selector would satisfy itself.
  const appOutsideTours = app.replace(toursBlock(app), "");
  for (const sel of tourSels(app))
    for (const t of selectorTokens(sel)) {
      if (t.kind === "id" ? !hasId(appOutsideTours, t.name) : !hasClass(appOutsideTours, t.name))
        v.push(`[QA-DRIFT:TOUR-SEL] TOURS step selector "${sel}": ${t.kind} "${t.name}" is not in app_template.html`);
    }
  for (const k of tours) if (!named.has(`tour:${k}`)) v.push(`[QA-DRIFT:UNCOVERED] TOURS key "${k}" has no case (add ref tour:${k})`);
  for (const m of momentValues(inp.transitionsPy)) if (!named.has(`moment:${m}`)) v.push(`[QA-DRIFT:UNCOVERED] MOMENTS value "${m}" has no case (add ref moment:${m})`);
  for (const k of digestKinds(inp.monitorSources)) if (!named.has(`digest:${k}`)) v.push(`[QA-DRIFT:UNCOVERED] digest kind "${k}" has no case (add ref digest:${k})`);
  for (const s of screenIds(app)) if (!named.has(`#${s}`)) v.push(`[QA-DRIFT:UNCOVERED] screen #${s} has no case (add ref #${s})`);
  for (const f of inp.e2eFiles) if (!named.has(`tests/e2e/${f}`)) v.push(`[QA-DRIFT:UNLISTED] tests/e2e/${f} is named by no case`);
  return v;
}

export function loadInputs(root = ROOT) {
  const read = p => readFileSync(path.join(root, p), "utf8");
  const monDir = path.join(root, "monitor");
  return {
    cases: loadCases(root),
    app: read("app_template.html"),
    transitionsPy: read("monitor/transitions.py"),
    monitorSources: readdirSync(monDir).filter(f => f.endsWith(".py")).map(f => read(`monitor/${f}`)),
    e2eFiles: readdirSync(path.join(root, "tests", "e2e")).filter(f => f.endsWith(".spec.mjs")),
    fileExists: rel => existsSync(path.join(root, rel)),
  };
}

export function checklistDrift(root = ROOT) {
  for (const py of ["python", "python3", "py"]) {
    const r = spawnSync(py, ["qa/build_checklist.py", "--check"], { cwd: root, encoding: "utf8" });
    if (r.error) continue;
    return r.status === 0 ? [] : [`[QA-DRIFT:CHECKLIST] ${(r.stdout + r.stderr).trim() || "qa/RELEASE-CHECKLIST.md is stale"}`];
  }
  return ["[QA-DRIFT:CHECKLIST] no python interpreter found to run qa/build_checklist.py --check"];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const v = [...runChecks(loadInputs()), ...checklistDrift()];
  if (v.length) { console.error(v.join("\n")); console.error(`\nqa-drift: ${v.length} violation(s). Update qa/cases/*.yaml in the same commit as the behaviour change, then run: python qa/build_checklist.py`); process.exit(1); }
  console.log(`qa-drift: ok (${loadCases().length} cases, ${Date.now() - t0}ms)`);
}
