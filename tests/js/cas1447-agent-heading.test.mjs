// CAS-1447: Alerts/Watch agent group headings must never print "undefined" for an icon-less v2 agent.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("heading is the name alone when the agent has no icon", () => {
  const h = E.agentHeadingHTML({ name: "Pixel" });
  assert.equal(h, "Pixel");
  assert.ok(!/undefined/.test(h));
});
test("heading keeps the icon when the agent has one", () => {
  assert.equal(E.agentHeadingHTML({ icon: "🔍", name: "Pixel" }), "🔍 Pixel");
});
