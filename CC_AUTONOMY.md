# Worker contract — CAS (web)

Rendered from `CC_AUTONOMY.template.md` in the Codynamics Bootstrap Kit, with the placeholders filled from
`pipeline.config.json`. It supersedes `CC_AUTONOMY_CASCADE_WEB.md`, which was label-only and predated the
status workflow.

You are an autonomous Claude Code worker on `LCP2/cascade-web`. Do exactly **ONE** ticket this run, then
stop. Never commit secrets.

## Pick your work
1. **Reclaim first.** If you left a ticket in `In Progress` assigned to you, resume it.
2. Otherwise take the top of:
   `project = CAS AND status = "Ready for Dev" AND labels = "needs-cc-web"`
   ordered by priority DESC, key ASC. Take exactly one.
3. **Claim it atomically:** transition it to `In Progress` and assign yourself **before** touching code.
   (This is what lets two workers share one queue without collision.)
4. **Jira auth — one shared token.** Authenticate every call with the token set once via `setx ATLASSIAN_API_TOKEN`:
   `-u "lee@codynamics.com.au:$env:ATLASSIAN_API_TOKEN"`. Email/site are non-secret (from `pipeline.config.json`).
   There is **no** separate `JIRA_API_TOKEN` var — the CI `JIRA_*` secrets are a different, Actions-only context.

> **Cascade specific — releases are LABELS, not Jira Versions.** Do not set `fixVersion`, and do not call
> `jira_release.py`; neither is used on this project. A release is the per-release label `v<X.Y.Z>` carried
> by every ticket in it, and it is already on the ticket when you pick it up. Leave it alone.

> **CAS-482 — diagnose before retrying a requeued ticket.** `qa.yml`'s `on-failure` job (CAS-482) auto-
> requeues a ticket to `Ready for Dev` + `needs-cc-web` when its push made QA go red, and posts a Jira
> comment naming the failed job(s), the first failing line, and a link to the run — read that comment
> first. Before touching code on any ticket you pick up this way, check whether the failure is actually
> caused by **this ticket's own diff**: `git show <the ticket's commit> -- <the failing area>` against the
> failing job's detail in the comment. Two outcomes:
> - **This ticket's diff caused it** — normal work: fix it, verify, push again.
> - **It didn't** (e.g. a data-driven catalogue invariant tripped by an unrelated `daily.yml` refresh, the
>   CAS-481 shape) — do not blindly re-push a ticket that changes nothing about the failure. Check whether
>   an existing ticket already tracks the real cause (search `project = CAS AND text ~ "<the failing
>   test/assertion>"`) before filing a new one. Comment on the requeued ticket explaining your diff isn't
>   the cause, link the tracking ticket if one already exists (file one if not), and move it back to
>   `Ready for Dev` un-changed rather than re-pushing.

## Read the ticket — BUILD MODE and the design image

**The first line of a ticket's description is its BUILD MODE line.** It tells you whether
you are applying someone else's finished work or designing the implementation yourself.
These need opposite behaviour from you, so read it before anything else.

**On pickup, check `C:\Dev\cascade-web-Images\` for `<KEY>.*`** (png/jpg/jpeg/webp — one
image per ticket, named exactly by the ticket key). If one is there, read it. What it means
depends on the mode. If the ticket refers to an image and none is there, do not invent one:
stop, label it `needs-lee`, and say which key you looked for.

### BUILD MODE: EXACT — the ticket carries the literal diff
- Apply each hunk **verbatim**. Do not reinterpret, re-derive, tidy, reformat, re-indent,
  rename or improve it, and do not "fix" something you think is wrong on the way past.
- The image is **EVIDENCE of the result, not the specification.** Where the image and the
  diff appear to disagree, **the diff wins.** Do not build to the picture.
- If a hunk no longer applies — the anchor text has moved, changed, or occurs a different
  number of times — **STOP**. Add `needs-lee`, comment which hunk failed and what you
  actually found at the anchor, and set the ticket BLOCKED. Do not reconstruct the intent.
- You still write anything the ticket explicitly marks as code for you to write.

### BUILD MODE: INDICATIVE — the ticket describes the intended result
- The image **IS the reference for the result** — layout, spacing, colour and copy — ahead
  of prose describing appearance.
- You choose the markup and CSS. You must still satisfy every acceptance criterion.
- Prose wins on behaviour; the image wins on appearance. If they disagree on **behaviour**,
  block with `needs-lee` rather than picking one.

### Mixed tickets
The mode line states the ticket's default. A section may override it with its own heading —
`INDICATIVE — the worker writes this` inside an EXACT ticket, or `EXACT — apply verbatim`
inside an INDICATIVE one. This is normal here: CSS and static markup can be handed over
finished; new JS behaviour cannot.

### No mode line
Treat the ticket as **INDICATIVE**. But if it contains what looks like a literal diff and
carries no `EXACT` line, that is a shaping defect, not an invitation to guess — block with
`needs-lee` and ask.

An EXACT ticket also carries the label `spec-exact`, so the mode is visible on the board.
The **mode line is authoritative** if the two ever disagree.

## Do the work
- Implement to the **acceptance criteria and nothing beyond**. Honour the out-of-scope list.
- Read the Confluence **Cascade Web — Architecture & CC Build Spec** and **UX Psychology —
  Principles & Cascade Applications** before any craft or design decision. Truthful copy only: never a
  fabricated count, urgency, timer or capability.
- Front-end work goes in `app_template.html`. Backend/monitor work goes in `/monitor/` or
  `/supabase/schema.sql`; schema changes that must be applied to a live project are a **Lee step** —
  describe them in the ticket, never run SQL against a live project.
- **Run `npm run build` (`python poc_pipeline.py --build-html`) before every commit to `staging`,
  regardless of ticket type** — including e2e-only or backend/monitor-only tickets that never touch
  `app_template.html`. It regenerates `index.html` **and** stamps `version.json`'s `build`/`commit` fields
  from the current git `HEAD`; skip it on a given commit and both files silently carry the *previous*
  commit's stamp forward; nothing in `qa.yml` catches this, since its `build-check` job explicitly
  excludes `BUILD_INFO` drift from its staleness check (by design — see that job's comment). Commit
  `index.html` and `version.json` together with the rest of the ticket's diff every time, even when
  `index.html`'s only change is its stamp. (CAS-537: a test-only commit skipped this step, and the footer's
  build stamp under-reported every ship for several tickets until a later front-end ticket happened to
  rebuild.)
- **Do not write a Playwright spec for your ticket.** The e2e gate is `tests/e2e/smoke.spec.mjs` only
  (CAS-385); per-ticket `cas<NNN>.spec.mjs` files are not run by CI. Only add or change an e2e spec when
  the ticket text explicitly asks for it.
- **Verify fast in-session; CI is the gate.** The full gate runs in CI on every push to `staging`
  (`.github/workflows/qa.yml`). In-session, run exactly these three checks against your build,
  synchronously, one at a time, in the foreground of this same run — never background one and schedule a
  wakeup to check on it later; that starts a fresh paid run that re-does all the diagnosis from scratch:
  1. `npm run build`
  2. `npm run test:lint`
  3. `npm run test:engine`
  Do **not** run `npm run test:data`, `npm run test:monitor`, `npm run test:e2e`, or any Playwright spec
  in-session. CI owns them: its `data` job runs `python -m tests.run_data_quality` (CAS-405), which
  splits blocking app-breakers from report-only checks — a flat local `python -m unittest discover -s
  tests` has no such split, so known report-only failures (e.g. the CAS-227 upcoming latch) read as red
  locally and burn the run diagnosing failures that are not yours.

  Capture each command's **real exit code immediately after that command**, never through a pipe —
  `cmd | tail` reports `tail`'s exit code, not the command's, so a real failure can silently read as
  green. If a command's output is too large to keep in context, redirect it to a file and only read the
  file (with `tail`/`grep`) after you've already checked the exit code: run
  `npm run build > /tmp/build.log 2>&1; BUILD_EXIT=$?` and only then
  `[ $BUILD_EXIT -ne 0 ] && tail -50 /tmp/build.log`. Do not proceed on red. On green, commit and push to
  `staging` — CI's QA run is the authoritative gate.
- If a ticket says an asset or spec "will be attached" and it is not in the ticket text, **do not invent
  it** — stop, label it `needs-lee`, and say what is missing.
- **Put any worktree you create INSIDE the repo**, at `.claude/worktrees/<TICKET-KEY>`, never as a sibling
  directory such as `C:\Dev\cascade-web-CAS635`. A sibling path is outside your approved directory: you
  cannot read the files you just checked out there, the run ends with no commit, and the ticket strands in
  Developing. Two runs were lost this way on 27 Aug 2026. `.claude/worktrees/` is already inside the repo
  and needs no approval. Remove the worktree when you are done.

## Hand off
- Commit as `CAS-NN: <summary>`, push to **`staging`** (never `main`).
- Transition the ticket to `In Review`.
- Swap the labels `needs-cc-web` → `on-staging` as belt-and-braces, so the queue is correct even if a
  transition fails.
- Comment on the ticket saying what shipped and any live step Lee must do.

Cascade's workflow transition IDs are 4 = In Progress and 5 = In Review, but **prefer transition-by-name**:
read `/rest/api/3/issue/CAS-NN/transitions` and match on the target status name, so a workflow edit cannot
silently send tickets to the wrong place.

## Test upkeep
- Any ticket that adds, removes or changes a tour step (`TOURS` in `app_template.html`) updates
  `tests/e2e/tutorial-geometry.spec.mjs` in the same commit (CAS-1582): it checks every step's ring, arrow,
  bubble position and stability at 390x844, and fails on a silently skipped step.

## Finish
Print exactly one outcome marker on the final line:
`DONE <sha>` | `ALREADY-DONE` | `BLOCKED <reason>` | `NO_WORK`

## Never
- Never background your own verify commands (build/unit tests/the ticket's Playwright spec) and schedule a
  wakeup to check on them later. Run them synchronously in the foreground of this same run and read their
  real exit codes directly — a scheduled wakeup starts a new paid run that re-does the diagnosis from
  scratch instead of resuming, which has already wasted real runs on this project.
- Never write to `main`. Never `git checkout main`, merge to main, push main, or force-push anything.
  Only `promote.yml` writes `main` (it fires automatically on a green QA — recorded Cascade exemption).
- Workflow, CI and signing files may be edited **only** when the ticket text explicitly names the exact
  file, and then **only** on `staging`. Without that explicit naming, the existing behaviour stands: set
  it `BLOCKED` and add the `needs-lee` label. See the Cascade method page — *QA and Deploy — how Cascade
  actually ships*, section 2 "Who may do what" — for the governing rule.
- Never enter credentials, accept store agreements, or run a deploy. Those stop at the human.
- Never print or log a secret. The Supabase **anon** key may live in the front-end; `service_role` and
  `RESEND_API_KEY` are server-side only. Row-level security stays ON for every user table, and the monitor
  stays the only writer of `notifications`.
- If `cloud-cc/PAUSED` exists in the repo, do nothing.
