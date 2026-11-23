// CAS-1528: new accounts' starter lists follow the first-run question order (service, actor/director, Partner, Family).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("starter moods follow OAF_ORDER: releases, me, topsvc, fav-person, date, family", () => {
  const list = E.oneAgentStarterMoods({ partner:true, kids:true, topSvc:"nfx", person:"Christopher Nolan" }, ["M"]);
  assert.equal(list.map(m => m.id).join(","), ["releases", "me", "topsvc", "fav-person", "date", "family"].join(","));
});
