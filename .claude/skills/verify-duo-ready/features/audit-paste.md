# Audit pasted code

Pasted Swift is audited on its own. Fixes show a line diff with indentation kept, and the result is marked partial because project-level checks can't run.

## Sub-features

- `paste-diff` previews each fix as a diff.
- `paste-partial` caps the grade and marks project chips `not checked`.

## How to get to it (user POV)

- On `#audit`, choose `Paste Swift`, paste code into `Swift source`, and choose `Audit`.

## Driving it with verify.mjs

Preconditions: none.

- **Paste.** Fill `Swift source` with a view controller method that reads `UIScreen.main.scale`, then choose `Audit`. `.diff` contains `traitCollection.displayScale` and `partial` is visible.

## Gotchas

- `UIScreen.main` fixes are offered only inside a UIKit view or view controller instance method. Pasting a bare `let s = UIScreen.main.scale` gives a finding with no fix.
