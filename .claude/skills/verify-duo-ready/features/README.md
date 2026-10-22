# duo-ready verification map

One file per user-facing feature. The file name matches the function in `../verify.mjs`.

## Baseline

- `npm install` has run. `verify.mjs` builds and serves the lab itself on `127.0.0.1:$PORT`.
- Start every browser feature from a fresh page. State lives only in the page, so there is nothing to reset.
- The sample app is `sample/Encore`. It produces 31 findings, 2 safe fixes and 3 review fixes.

## Features

- `preview.md` covers poses, SDK builds, collisions, and the recommended-changes list.
- `fold-test.md` covers state kept or lost when the phone opens or closes.
- `split-view.md` covers the 50/50 Split View pose.
- `audit-sample.md` covers the sample audit, the worst-screens list, fix selection, the zip, and pain-point links.
- `audit-paste.md` covers pasted code, fix previews, and partial audits.
- `audit-folder.md` covers choosing a project folder.
- `rules.md` covers the rules page and deep links.
- `cli.md` covers the report, dry run, fixing in place, and the rules command.

## Proof standards

- Drive the user path (radios, buttons, file inputs, the CLI binary), never internal functions.
- Capture the state after the action. Read side effects back: the zip's contents, the rewritten file on disk.
- Report a step that could not run as `inconclusive`, never as passed.
