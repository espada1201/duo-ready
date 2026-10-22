# Fold test

After a pose change, the readout says what Encore kept and lost. The unchanged build swaps views on size class and loses the album list's scroll position. The recommended build keeps it.

## Sub-features

- `fold-lost` reports lost state when the size class changes on an unchanged build.
- `fold-kept` reports kept state on the recommended build.

## How to get to it (user POV)

- Change the pose on the Preview tab, then read `Fold test` in the side panel.

## Driving it with verify.mjs

Preconditions: none.

- **Lose state.** Check `iOS 27.1 SDK`, then `Closed`, then `Open`. `continuity` contains `Lost: your scroll position in the album list`.
- **Keep state.** Check `27.1 + recommended changes`, then `Closed`. `continuity` contains `the views didn’t`.

## Gotchas

- The iOS 26 build never changes size class (it stays in a compatibility window), so it never loses state. Use a 27.x build to see loss.
