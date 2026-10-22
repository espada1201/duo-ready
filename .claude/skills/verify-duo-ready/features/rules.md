# Why it breaks (rules page)

The rules page explains each reviewer pain point, its root cause, and the checks that catch it, with the Apple source for each. Rule and pain-point links focus their target.

## Sub-features

- `rules-list` lists all 28 checks.
- `rules-deeplink` focuses `#rules/<rule-id>` and `#rules/pain-<id>`.

## How to get to it (user POV)

- Choose `Why it breaks`, or follow a `Why` or `Source` link from Preview or Audit.

## Driving it with verify.mjs

Preconditions: none.

- **Deep link.** Open `#rules/keyboard-frame`. `#rule-keyboard-frame` has focus and 28 `.rule` items render.

## Gotchas

- Focus moves in a `requestAnimationFrame`. Wait for `document.activeElement`, don't read it right after navigation.
