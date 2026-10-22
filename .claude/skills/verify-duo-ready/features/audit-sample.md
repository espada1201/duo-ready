# Audit the sample app

The Audit tab scores a project, ranks the screens to fix first, groups findings by reviewer pain point, and downloads a zip of fixed files.

## Sub-features

- `audit-score` shows the score, grade and counts.
- `audit-screens` lists the screens and files whose fixes gain the most points first.
- `audit-fixes` selects safe fixes by default and lets you add review fixes.
- `audit-zip` downloads only the changed files, fixed.
- `audit-filter` narrows the list by severity, pain point or fixability.
- `audit-pain-links` opens a pain point's section on the rules page.

## How to get to it (user POV)

- Open `#audit` and choose `Try the sample app`.

## Driving it with verify.mjs

Preconditions: none.

- **Run.** Choose `Try the sample app`. 31 `.finding` items render and `screens` contains `PlayerViewController`.
- **Select a review fix.** Check the box in `.finding[data-rule="tab-sidebar"]`. `download` reads `Download 3 fixes`.
- **Download.** Choose `download`. The saved `fixes.zip` has `Encore/Encore/LibraryView.swift` containing `.defaultTabBarPlacement(.sidebar)`.
- **Filter.** Choose `8 errors`: 8 `.finding.sev-error` items and `download` notes the fixes hidden by the filter. `Show all` restores 31.
- **Pain link.** Choose the `Breaks when you fold or unfold` chip. The URL ends `#rules/pain-fold` and `#pain-fold` has focus.

## Gotchas

- The download label counts fixes that will actually apply. Overlapping fixes are skipped, so it can be lower than the number ticked.
- Pain-point chips hold two controls: the title links to the rules page, the count filters the list.
