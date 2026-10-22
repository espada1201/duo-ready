# Split View

The Split View pose gives the app the leading half of the inner display at compact width, with another app drawn beside it.

## Sub-features

- `split-window` sizes the window to half the inner display.
- `split-other` draws the other app.

## How to get to it (user POV)

- Check the `Split View` pose on the Preview tab.

## Driving it with verify.mjs

Preconditions: none.

- **Split.** Check `iOS 27.1 SDK`, then `Split View`. `window` reads `445 × 626 pt, 100% of its half of the display` and `.other-app` is visible.

## Gotchas

- Coverage is measured against the app's half, so 100% is correct here, not 50%.
