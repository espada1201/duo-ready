# Preview

The Preview tab shows Encore, a typical iPhone music app, on every Duo pose for each SDK build. It marks the black bars, collisions with the hinge, camera and status bar, and lists what the recommended build changes.

## Sub-features

- `poses` switches between Closed, Closed sideways, Open, Open rotated, Split View, Half folded, book and Half folded, propped up.
- `builds` switches between the iOS 26, 27 and 27.1 SDKs and `27.1 + recommended changes`.
- `problems` lists collisions and black bars for the current pose.
- `screenshot` shows the person's own screenshot whole (contain, not cropped) in the compatibility window on the inner display; while one is loaded the problems say they come from the sample app, not the screenshot.
- `changes` lists what the recommended build changes, split into applied, suggested and manual.

## How to get to it (user POV)

- Open the lab. Preview is the default tab (`#preview`).

## Driving it with verify.mjs

Preconditions: none beyond the baseline.

- **Old SDK.** Load the page. `window` reads `430 × 626 pt, 48% of the display`.
- **Fold.** Check the `Book` radio. `problems` contains `The hinge cuts through`.
- **Rebuild unchanged.** Check `iOS 27.1 SDK`. At least one `.overlay-collision` is drawn.
- **Recommended build.** Check `27.1 + recommended changes`. `problems` contains `No collisions` and `changes` contains `NavigationView becomes NavigationStack`.

## Gotchas

- Pose radios are visually hidden inputs inside labels. Use `getByRole('radio').check()`, not a click on the label text.
- The stage redraws on resize through a ResizeObserver. Screenshot after the assertion, not before.
