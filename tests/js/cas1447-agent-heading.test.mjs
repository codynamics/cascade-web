// CAS-1447: Alerts/Watch agent group headings must never print "undefined" for an icon-less v2 agent.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("heading is "Your agent" alone when the agent has no icon", () => {
  const h = E.agentHeadingHTML({ name: "Pixel" });
  assert.equal(h, "Your agent");   // CAS-1692: the stored name is never shown
  assert.ok(!/undefined/.test(h));
});
test("heading keeps the icon when the agent has one", () => {
  assert.equal(E.agentHeadingHTML({ icon: "🔍", name: "Pixel" }), "🔍 Your agent");
});
