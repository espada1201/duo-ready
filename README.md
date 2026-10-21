# duo-ready

Most iPhone apps look wrong on iPhone Duo: black bars, stretched layouts, custom bars that ignore the side status bar, and content that runs straight under the hinge. Apple's fix is a rebuild with the iOS 27.1 SDK plus layout changes that each app's developer has to make. duo-ready finds those changes and makes the safe ones for you.

iOS doesn't let anyone reshape someone else's app, so this kit is for the people who build apps.

## Run on your Mac

1. Install Homebrew from https://brew.sh if you don't have it.
2. In Terminal, run `brew install node`.
3. Download this repo, then `cd` into its folder in Terminal.
4. Run `npm install && npm start`.
5. Your browser opens the Duo Lab at http://localhost:4178.

## What's inside

- **Duo Lab (browser).** *Preview* shows a typical app on all six Duo poses for each SDK build, with reserved regions, safe areas and every collision marked. *Audit* takes your Xcode project folder (it never leaves your Mac), scores it, explains each problem with Apple's guidance, and gives you a zip of fixed files.
- **CLI.** The same engine for terminals and CI:
  ```sh
  npm run audit -- ../MyApp              # report
  npm run audit -- ../MyApp --dry-run    # preview fixes as a diff
  npm run audit -- ../MyApp --fix        # apply safe fixes (--fix=all for the rest)
  npm run audit -- ../MyApp --format sarif --out duo.sarif   # GitHub code scanning
  ```
  Try it on the bundled legacy app: `npm run audit -- sample`.

## The rules

17 checks traced to Apple's iPhone Duo tech talks: `UIScreen.main`, idiom and orientation checks, symmetric safe-area math, hard-coded iPhone sizes, hand-built bars, `NavigationView`, `ArrangementView` misuse, missing sidebar, centered columns, hand-rolled two-pane layouts, portrait lock, `UIRequiresFullScreen`, missing scene lifecycle, pre-27.1 Xcode, and React Native / Flutter. `npm run audit -- rules` lists them.

Fixes come in two kinds. *Safe* ones (`UIScreen.main.scale` to `traitCollection.displayScale`, safe-area insets, `NavigationView` to `NavigationStack`) keep behavior. *Review* ones change it and are never applied without `--fix=all` or a tick.

## Limits

- The scanner is pattern- and structure-based, not a Swift compiler. It skips comments and strings, but unusual code can slip past or trip it.
- Duo panel sizes come from Apple's specs; hinge, camera and status bar geometry are approximations. Check in the Xcode 27.1 simulator.
- The SDK tier is estimated from the project's `LastUpgradeCheck`.

## Develop

`npm test` (unit), `npm run e2e` (Playwright), `npm run typecheck`. The Pages workflow needs the repo to be public.
