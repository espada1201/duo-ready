---
name: verify-duo-ready
description: Prove duo-ready works by driving the real Duo Lab (browser) and CLI the way a developer does, with screenshots, ARIA snapshots and transcripts as evidence. Use before claiming a change to duo-ready works, or to check every feature after a refactor.
---

# Verify duo-ready

duo-ready has two surfaces. The Duo Lab is a static Vite app (Preview, Audit, Why it breaks). The CLI is `dist-cli/duo-ready.js`. `verify.mjs` drives both.

## Launch

`node .claude/skills/verify-duo-ready/verify.mjs all` runs `npm run build`, serves `dist/` with `vite preview` on `127.0.0.1:$PORT` (default 4190, `--strictPort`), waits until the page answers, drives every feature in the map, then stops the server it started. Name features to run a subset: `verify.mjs fold-test cli`. It needs `npm install` first. Two runs side by side need different `PORT`s.

## Doctor

`node .claude/skills/verify-duo-ready/verify.mjs doctor` is read-only. It reports whether the lab answers on `$PORT` and whether `dist/` and `dist-cli/` exist. Exit 0 means a running instance is worth driving. Outside a run it reports `down`, because each run owns its server.

## Drive

Each feature is a function in `verify.mjs` named after its file in `features/`. Handles are roles and test ids from the app: radios named after poses and builds (`Book`, `Split View`, `27.1 + recommended changes`), and `data-testid` values `window`, `problems`, `continuity`, `changes`, `screens`, `partial`, `download`, `folder-input`. Every step is an `assert` with the behavior as its message. A failing step prints `ISSUES <feature>: FAILED: <behavior>`.

## Evidence

Each feature writes to `$EVIDENCE_DIR/<feature>/`. The default is `/tmp/duo-ready-verify/<timestamp>/`. Browser features save a full-page screenshot and an ARIA snapshot after the action. `audit-sample` keeps the downloaded `fixes.zip` and checks its Swift. `cli` keeps the text report and fix transcript and reads the rewritten file back from disk. Every page also fails on any console error. A run ends with `PASS` or `ISSUES` per feature and exits 1 on any issue.

## Cleanup

The script kills only the `vite preview` it spawned, in a `finally`. CLI features write to fresh `mkdtemp` copies of `sample/`, never to the repo. Evidence is never deleted.

## Feature map

`features/README.md` indexes one file per feature. Add a file and a function together when the app gains a feature.
