// CAS-1549: build one QA account's first-run payload with the app's OWN engine, never in Python.
// Reads one JSON answer set on stdin, loads the built index.html the way monitor/admit_shim.mjs does, sets the
// first-run state (oafState), then calls oneAgentBuildDraft + oneAgentCommit (which calls oneAgentStarterMoods)
// and maps the result through the app's own row builders (CascadeShape.cascadeToRow, userPrefsRow, prefsRow) —
// exactly the payload membCompleteNewMembership sends to complete_membership.
//
// Request: { where:[cinema|rent|stream], partner:"yes"|"no", children:"yes"|"no"|null, age:"18plus"|"under18",
//            favs:[genre,...] (the ♥ genres; every other genre stays ✓), together:[genre,...], family:[genre,...],
//            services:[sub service names], topSvc:string|null, person:string, name:string }
// Response: { agents:[{id,name,criteria,alert_moments,active}], prefs:{...}, notify:{...}, moods:[...] }
import { loadEngine } from "../../tests/js/engine.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const req = JSON.parse(await readStdin());
const E = loadEngine();
E.prefs.sub.clear();
(req.services || []).forEach(s => E.prefs.sub.add(s));
E.prefs.touched = true;
const pick = (list, v) => Object.fromEntries((list || []).map(g => [g, v]));
const favs = Object.fromEntries(E.ONE_AGENT_SETUP_STYLES.map(g => [g, (req.favs || []).includes(g) ? "fav" : "incl"]));
E.setOafState({
  where: new Set(req.where || []), favs, age: req.age, partner: req.partner, children: req.children || null,
  together: pick(req.together, "incl"), togetherInit: true, family: pick(req.family, "incl"), familyInit: true,
  name: req.name || "", topSvc: req.topSvc || null, person: req.person || "",
});
const draft = E.oneAgentBuildDraft();
E.oneAgentCommit(draft);
const CP = E.CascadePersistence;
const prefs = CP.userPrefsRow(); delete prefs.user_id;
const notify = CP.prefsRow(); delete notify.user_id;
const agents = E.cascades.map(c => {
  const row = E.cascadeToRow(c);
  return { id: row.id, name: row.name, criteria: row.criteria, alert_moments: row.alert_moments, active: row.active };
});
process.stdout.write(JSON.stringify({ agents, prefs, notify, moods: draft.moods }));
