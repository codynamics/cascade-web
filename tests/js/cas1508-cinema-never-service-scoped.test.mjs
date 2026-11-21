// CAS-1508: cinema windows are never service-scoped. A film still in cinemas that has also gained a PVOD buy
// offer was rejected by matchesServices(m, "in_cinema") for every account with the services switch on.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function cinemaFilmWithPvod(){
  return { tmdb_id:91750001, title:"CAS-1508 fixture", genres:["Action"], status:["in_cinema"],
    wm_critic_score:null, wm_user_rating:9, availability_confidence:"confirmed",
    offers:[{service:"Apple TV Store", type:"buy", price:null, format:null}],
    cinema_release:true, cinema_date:E.TODAY };   // deliberately NOT _fixture: that flag bypasses the gate
}
function withServicesOn(fn){
  const savedOn = E.prefs.on, savedSub = new Set(E.prefs.sub), savedStore = new Set(E.prefs.store);
  E.prefs.on = true; E.prefs.sub.clear(); E.prefs.store.clear();
  try{ return fn(); } finally {
    E.prefs.on = savedOn;
    E.prefs.sub.clear(); savedSub.forEach(v=>E.prefs.sub.add(v));
    E.prefs.store.clear(); savedStore.forEach(v=>E.prefs.store.add(v));
  }
}

test("CAS-1508 AC1: an in-cinema film with only a PVOD offer matches services for in_cinema", () => {
  withServicesOn(() => {
    const m = cinemaFilmWithPvod();
    assert.equal(E.matchesServices(m, "in_cinema"), true);
    assert.equal(E.matchesServices(m, "upcoming"), true);
  });
});

test("CAS-1508 AC2: the same film is still service-scoped for the home windows", () => {
  withServicesOn(() => {
    assert.equal(E.matchesServices(cinemaFilmWithPvod(), "pvod"), false);
  });
});

test("CAS-1508 AC3: \"Where it lists\" does not blame services for an in-cinema film", () => {
  withServicesOn(() => {
    const c = { id:"cas1508-fixture", name:"Agent", v:2,
      styles:{ Action:{ bar:1, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
    const r = E.oamWilCase(cinemaFilmWithPvod(), c);
    assert.doesNotMatch(r.sentence, /isn't one of your services/);
  });
});
