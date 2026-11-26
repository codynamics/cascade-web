// CAS-1555: the app's OWN tutorial-banner decision (tutBannerDecide, CAS-1534) asked of the built index.html, so the
// first-days simulator never re-derives an app-side rule. Reads {"cases":[{"key","createdAt","now"}]} (now = epoch ms)
// on stdin; writes [true|false, ...]. The account is signed in, has seen nothing, and the tutorial has steps.
import { loadEngine } from "../tests/js/engine.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const out = (req.cases || []).map(c => !!E.tutBannerDecide({
    key: c.key, now: c.now, createdAt: c.createdAt, signedIn: true, seen: {}, steps: 3,
    shownThisVisit: false, blocked: false }));
  process.stdout.write(JSON.stringify(out));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
