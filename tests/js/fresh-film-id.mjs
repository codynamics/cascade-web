// CAS-1212: shared by cas1196-answer-param.test.mjs and cas1205-film-page-member.test.mjs (and asserted
// directly by cas1212-fresh-film-id.test.mjs) — the first unused film in the real, daily-refreshed
// catalogue. A case built around a specific Watch On level (in_cinema/rent/stream) passes that level as
// levelKey, so it never lands on a film the catalogue has already moved past for that level (CAS-280: a
// film can only be told about where it is still going, so a spent level's own toggleFilmOpt is a no-op —
// previously this picked the catalogue's first unused film regardless of status, which broke whenever
// that film's level for the case at hand was already spent).
export function freshFilmId(E, used, levelKey){
  const m = E.MOVIES.find(x => {
    if(used.has(x.tmdb_id)) return false;
    if(!levelKey) return true;
    const level = E.watchLevelsFor(x.tmdb_id).find(l => l.key === levelKey);
    return !!level && level.spent !== true;
  });
  if(!m){
    throw new Error(levelKey
      ? `freshFilmId: no unused film has an unspent "${levelKey}" level in the current catalogue`
      : "freshFilmId: no unused film left in the current catalogue");
  }
  used.add(m.tmdb_id);
  return m;
}
