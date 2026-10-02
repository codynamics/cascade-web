// CAS-917 built the start-window model this file pinned: a later enabled window was always "followed"
// once an agent had a start window, marker or not, so an admitted film's Watch On moved forward into it
// automatically. CAS-1128 (Lee, 2026-10-01) retires that model entirely for the Cascade score control,
// superseding it with independent per-window on/off toggles — a window is followed only when it is itself
// switched ON for the agent (windowFollowed === windowUsable now), never just because it ranks after
// wherever the agent "starts". Every AC this file pinned (a marker-less window after the start still
// admits/follows; msnValueLine naming every window at or after the start; msnChipsHTML's start/follow/
// before-start chip shapes) asserts exactly the behaviour CAS-1128 replaces, so none of them survive in
// their original form.
//
// The new behaviour (an OFF window is skipped, not followed, until the film itself reaches an ON one) is
// covered by tests/js/cas1128-track-in.test.mjs's AC2; msnValueLine's new copy by its AC3; the independent
// per-window pill row (msnPillsHTML, replacing msnChipsHTML) by its AC5. This file is kept only as a
// pointer — deleting it outright would lose the "why" a future reader would otherwise have to dig for in
// git history.
