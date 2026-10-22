# duo-ready

Most iPhone apps look wrong on iPhone Duo: black bars, stretched layouts, custom bars that ignore the side status bar, and content that runs straight under the hinge. Apple's fix is a rebuild with the iOS 27.1 SDK plus layout changes that each app's developer has to make. duo-ready finds those changes and makes the safe ones for you.

iOS doesn't let anyone reshape someone else's app, so this kit is for the people who build apps.

## Run on your Mac

1. Install Homebrew from https://brew.sh if you don't have it.
2. In Terminal, run `brew install node`.
3. Run `git clone https://github.com/espada1201/duo-ready.git && cd duo-ready`.
4. Run `npm install && npm start`.
5. Your browser opens the Duo Lab at http://localhost:4178.

## What's inside

- **Duo Lab (browser).** *Audit* takes your Xcode project folder (it never leaves your Mac), scores it, names the screens to fix first, filters findings by severity or pain point, explains each problem with Apple's guidance, and gives you a zip of fixed files. *Preview* shows a typical app in every Duo pose, Split View included, for each SDK build, and whether it keeps your place when you fold.
- **CLI.** The same engine for terminals and CI:
  ```sh
  npm run audit -- ../MyApp              # report
  npm run audit -- ../MyApp --dry-run    # preview fixes as a diff
  npm run audit -- ../MyApp --fix        # apply safe fixes (--fix all for the rest)
  ```
  `--format json` or `sarif` (for GitHub code scanning) keeps stdout machine-readable; add `-s`
  (`npm run -s audit -- ...`) so npm's own banner stays off it, or use `--out report.json`.
  Paths are relative to where you run the command. Exit codes: 0 clean, 1 findings at `--fail-on`
  (error by default; warning or note are stricter), 2 bad input. Try it on the bundled legacy app: `npm run audit -- sample`.

## The rules

28 checks, each traced to Apple's guidance (Duo Tech Talks, the HIG, framework docs), grouped by what reviewers saw. `npm run audit -- rules` lists them, and the Lab's *Why it breaks* tab explains each:

- **Black bars:** pre-27.1 Xcode, `UIRequiresFullScreen`, hard-coded iPhone sizes, centered columns.
- **Misplaced buttons and bars:** hand-built bars, symmetric safe-area math, missing tab sidebar, screen-edge swipes.
- **Small or stretched elements:** idiom checks, fixed font sizes, images without an aspect ratio, web viewports pinned to a phone width, SpriteKit scenes that stretch or letterbox.
- **Breaks when you fold or unfold:** views swapped on size class, `UIScreen.main`, key-window assumptions, orientation checks, portrait lock, missing scene lifecycle, `NavigationView`.
- **Ignores the hinge:** full-screen media, keyboard frame math, hand-rolled two-pane layouts, `ArrangementView` misuse, React Native / Flutter.
- **Assumes iPhone hardware:** Face ID only, force-unwrapped or TrueDepth cameras.

Fixes come in two kinds. *Safe fixes* are Apple's own before/after rewrites, offered only where the scanner can prove they compile (safe-area insets; single-column `NavigationView` to `NavigationStack` when the project deploys to iOS 16+). *Review fixes* (`UIScreen.main` replacements, the tab sidebar, `.scaledToFit()`) need a human look and are never applied without `--fix all` or a tick.

## Limits

- The scanner is pattern- and structure-based, not a Swift compiler. It skips comments and strings, but unusual code can slip past or trip it.
- Duo panel sizes come from Apple's specs; hinge, camera and status bar geometry are approximations. Check in the Xcode 27.1 simulator.
- The SDK tier is estimated from the project's `LastUpgradeCheck`.
- Tests, Xcode previews, widgets, watch and extension targets, build scripts and vendored folders (Pods, Carthage, build) are skipped: Duo users never see them.
- Pasted code or a lone Swift file gets a partial audit: project-level checks can't run, so the grade stops at Close.

## Develop

`npm test` (unit), `npm run e2e` (Playwright), `npm run typecheck`. The Pages workflow needs the repo to be public.
