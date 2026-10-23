# CLI

`duo-ready` audits a project folder from the terminal, prints a report, shows fixes as a diff, writes safe fixes in place, and lists its rules.

## Sub-features

- `cli-report` prints findings, the worst screens and the score, and exits 1 when errors remain; every run that exits 1 ends with one line saying what the 1 means.
- `cli-dry-run` shows the diff. With `--out <file>` the file gets the patch, so `git apply --check <file>` passes. With `--format json` or `sarif` the diff goes to stderr, `--out` still takes the report, and stdout stays valid.
- `cli-fix` writes safe fixes to disk (`--fix all` adds review fixes).
- `cli-rules` lists every check.

## How to get to it (user POV)

- `npm run audit -- <path>` from the repo, or `node dist-cli/duo-ready.js <path>`.

## Driving it with verify.mjs

Preconditions: `dist-cli/duo-ready.js` built (the run builds it).

- **Report.** Run `duo-ready sample --no-color`. Exit code 1, stdout contains `Fix these first` and no exit-code line, and the last line of stderr starts `Exit code 1 means findings at error or worse remain`.
- **Dry run.** Run `duo-ready sample --dry-run --format json --fail-on never`. stdout parses as JSON with 31 findings and stderr contains `+++ b/Encore/Encore/LibraryView.swift`.
- **Dry run to a file.** Run `duo-ready <copy of sample> --dry-run --out duo.patch --no-color`. stdout says `Patch written to`, and `git apply --check duo.patch` passes in the copy.
- **Fix.** Run `duo-ready <copy of sample> --fix`. The copy's `LibraryView.swift` now contains `NavigationStack {`. With the default `--fail-on`, stderr still ends with the exit-code line.
- **Rules.** Run `duo-ready rules`. stdout contains `game-aspect`.

## Gotchas

- `rules` is a path if a folder named `rules` exists in the working directory.
- Never run `--fix` on `sample/` itself. The unit and e2e tests expect it unfixed.
