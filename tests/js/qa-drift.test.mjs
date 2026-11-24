// CAS-1556: proves each rule of tests/lint/qa-drift.mjs fires, and that the real repo passes.
import test from "node:test";
import assert from "node:assert/strict";
import { runChecks, loadInputs, parseCases, selectorTokens, tourSels, digestKinds } from "../lint/qa-drift.mjs";

const real = () => loadInputs();
const codes = v => v.map(x => x.match(/^\[(QA-DRIFT:[A-Z-]+)\]/)[1]);

test("the committed repo has no drift", () => {
  assert.deepEqual(runChecks(real()), []);
});

test("R1: a case naming a removed element id fails", () => {
  const inp = real();
  inp.app = inp.app.split('id="moviesBtn"').join('id="renamedBtn"');
  const v = runChecks(inp);
  assert.ok(v.some(x => x.includes("QA-DRIFT:REF") && x.includes("#moviesBtn")), v.join("\n"));
});

test("R1: a case naming a removed function, or a missing file, fails", () => {
  const inp = real();
  inp.cases.push({ _file: "x.yaml", id: "X-1", part: "A", title: "t", how: "unit", expect: ["e"],
    refs: ["notARealFunction()", "tests/e2e/does-not-exist.spec.mjs"] });
  const v = runChecks(inp);
  assert.ok(v.some(x => x.includes("notARealFunction()")));
  assert.ok(v.some(x => x.includes("does-not-exist.spec.mjs")));
});

test("R2: a tour step whose selector target is missing fails", () => {
  const inp = real();
  inp.app = inp.app.replace('sel:["#moodAddBtn"]', 'sel:["#noSuchTourTarget"]');
  const v = runChecks(inp);
  assert.ok(v.some(x => x.includes("QA-DRIFT:TOUR-SEL") && x.includes("noSuchTourTarget")), v.join("\n"));
  const inp2 = real();
  inp2.app = inp2.app.replace('sel:[".stgroups"]', 'sel:[".no-such-class"]');
  assert.ok(runChecks(inp2).some(x => x.includes("QA-DRIFT:TOUR-SEL") && x.includes("no-such-class")));
});

test("R3: a new moment, tour key, digest kind or screen with no case fails", () => {
  const inp = real();
  inp.transitionsPy = inp.transitionsPy.replace('"new_to_agent")', '"new_to_agent", "brand_new_moment")');
  assert.ok(runChecks(inp).some(x => x.includes("UNCOVERED") && x.includes("brand_new_moment")));

  const t = real();
  t.app = t.app.replace("const TOURS = {", "const TOURS = {\n  freshtour:{ title:\"New\", steps:[] },");
  assert.ok(runChecks(t).some(x => x.includes("UNCOVERED") && x.includes("freshtour")));

  const d = real();
  d.monitorSources = [...d.monitorSources, 'def f():\n    render_digest(hits, kind="weekly_alert" if x else "daily_alert", batch_id=1)\n'];
  assert.ok(runChecks(d).some(x => x.includes("UNCOVERED") && x.includes("weekly_alert")));

  const s = real();
  s.app += '\n<div class="uscreen" id="shinyNewScreen"></div>';
  assert.ok(runChecks(s).some(x => x.includes("UNCOVERED") && x.includes("#shinyNewScreen")));
});

test("R4: an e2e spec file named by no case fails", () => {
  const inp = real();
  inp.e2eFiles = [...inp.e2eFiles, "brand-new.spec.mjs"];
  const v = runChecks(inp);
  assert.deepEqual(codes(v), ["QA-DRIFT:UNLISTED"]);
  assert.match(v[0], /brand-new\.spec\.mjs/);
});

test("case structure: missing fields and duplicate ids fail", () => {
  const inp = real();
  inp.cases.push({ _file: "x.yaml", id: "WATCH-001", part: "A", title: "dup", how: "unit", expect: ["e"], refs: [] });
  inp.cases.push({ _file: "x.yaml", id: "X-2", part: "A", title: "no how", expect: [], refs: [] });
  const v = runChecks(inp);
  assert.ok(v.some(x => x.includes("duplicate id")));
  assert.ok(v.some(x => x.includes("missing how")));
  assert.ok(v.some(x => x.includes("expect must list")));
});

test("helpers: selector tokens, tour sel extraction and digest kinds", () => {
  assert.deepEqual(selectorTokens('#navMenu .navitem[onclick*="invites"]'),
    [{ kind: "id", name: "navMenu" }, { kind: "class", name: "navitem" }]);
  assert.ok(tourSels(real().app).includes('.moodrow .moodchip[data-mood="releases"]'));
  assert.deepEqual(digestKinds(['def render_digest(a, kind: str = "daily_alert"):\n  pass\nrender_digest(h, kind="x_alert" if any(m == "catchup" for m in q) else "y_alert", z=1)']).sort(),
    ["daily_alert", "x_alert", "y_alert"]);
});

test("the YAML subset parses scalars, quoted strings and lists", () => {
  const c = parseCases('# c\n- id: A-1\n  part: A\n  title: "q: #x"\n  expect:\n    - one\n    - two\n  refs:\n    - "#id"\n', "t.yaml");
  assert.deepEqual(c, [{ _file: "t.yaml", id: "A-1", part: "A", title: "q: #x", expect: ["one", "two"], refs: ["#id"] }]);
  assert.throws(() => parseCases("garbage line", "t.yaml"));
});
