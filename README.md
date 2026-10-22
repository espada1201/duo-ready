# duo-ready

Most iPhone apps look wrong on iPhone Duo: black bars, stretched layouts, custom bars that ignore the side status bar, and content that runs straight under the hinge. Apple's fix is a rebuild with the iOS 27.1 SDK plus layout changes that each app's developer has to make. duo-ready finds those changes and makes the safe ones for you.

iOS doesn't let anyone reshape someone else's app, so this kit is for the people who build apps.

## Run on your Mac

1. Install Homebrew from https://brew.sh if you don't have it.
2. In Terminal, run `brew install node`.
3. Run `git clone https://github.com/espada1201/duo-ready.git && cd duo-ready`.
4. Run `npm install && npm start`.
5. Your browser opens the Duo Lab at http://localhost:4178 (or the next free port Terminal shows).

## What's inside

- **Duo Lab (browser).** *Audit* takes your Xcode project folder or a .zip of it (it never leaves your Mac), scores it, ranks what to fix first by the points it gains, filters findings by severity or pain point, explains each problem with Apple's guidance, and gives you the fixes as a zip or a git patch. *Preview* shows a typical app in every Duo pose, Split View included, for each SDK build, and whether it keeps your place when you fold.
- **CLI.** The same engine for terminals and CI:
  ```sh
  npm run audit -- ../MyApp              # report
  npm run audit -- ../MyApp --dry-run    # preview fixes as a patch git apply accepts
  npm run audit -- ../MyApp --fix        # apply safe fixes (--fix all for the rest)
  ```
  Try it on the bundled legacy app with `npm run audit -- sample`, or skip the clone with
  `npx github:espada1201/duo-ready ../MyApp`. Paths are relative to where you run the command.
  `--format json` or `sarif` (for GitHub code scanning) keeps stdout machine-readable; add `-s`
  (`npm run -s audit -- ...`) so npm's own banner stays off it, or use `--out report.json`.
  Exit codes: 0 nothing at `--fail-on` (error by default; warning or note are stricter), 1 findings at it, 2 bad input.

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

- The scanner is pattern- and structure-based, not a Swift compiler. It skips comments and strings, but unusual code can slip past or trip it. Objective-C files get the core checks (screen, idiom, orientation, keyboard, fonts, bars, gestures, cameras); fixes and SwiftUI checks are Swift only.
- Duo panel sizes come from Apple's specs; hinge, camera and status bar geometry are approximations. Check in the Xcode 27.1 simulator.
- The SDK tier is estimated from the project's `LastUpgradeCheck`.
- Tests, mocks, Xcode previews, `#if DEBUG` code, fallbacks for iOS versions older than Duo's, widgets, watch, Mac, TV and extension targets (and `#if os(...)` branches for them), build scripts, example apps and vendored folders (Pods, Carthage, Third Party, build) are skipped: Duo users never see them. Deployment targets are read from the Xcode project, `.xcconfig` files and XcodeGen specs.
- Pasted code or a lone Swift file gets a partial audit: project-level checks can't run, so the grade stops at Close.

## Develop

`npm test` (unit), `npm run e2e` (Playwright), `npm run typecheck`. The Pages workflow deploys the Lab once Pages is on (Settings > Pages > Source: GitHub Actions).
