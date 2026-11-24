# QA-AGENTS

The agent-behaviour suite is a deeper set of checks over the notify/agent-ownership engine
(`recomputeFound`, Watch On placement, moving/new-film tracking, alerting) than `npm run qa`
carries. It is deliberately **not** part of the gate — Lee's call, since `npm run qa` stays a
small, stable smoke gate and this suite is run on request instead.

It has two halves:
- `tests/js/agents.test.mjs` (CAS-1553: the one-agent model — admission, stages, alerts, verdicts, lists, starter lists), driven through `tests/js/engine.mjs` against the real shipped
  engine (same harness `npm run test:engine` uses).
- `monitor/agent_tests/`, a python suite kept out of `monitor/tests/` on purpose so
  `npm run qa`'s `test:monitor` step (`python -m unittest discover -s monitor/tests`) never
  discovers it.

Run it with:

```
npm run test:agents
```
