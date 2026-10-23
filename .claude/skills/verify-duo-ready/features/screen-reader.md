# Screen reader and keyboard access

Every control has a name, the poses form one labelled group, and results are spoken. The accessibility tree stands in for VoiceOver; a real Mac still has the last word.

## Sub-features

- `pose-radios`: seven radios named after their poses sit in a group named Pose; arrow keys move the selection and keep focus.
- `announce`: a pose change, a loaded project (name, score, grade, finding count) and a chosen screenshot are spoken through the `#announce` live region.
- `file-inputs`: the visually hidden file inputs are Tab stops named by their visible buttons (`Choose folder`, `Choose .zip`, `Try your own screenshot`), keep focus after a failed read, and show a focus ring on the label.

## Driving it with verify.mjs

- Focus `Open`, press ArrowRight: `Open, rotated` is checked and focused, and `#announce` starts with its name.
- On `#audit`, focus `#main`, press Tab: the `Choose folder` button is focused. Try the sample app: `#announce` reads `Audited Sample app: Encore: 10 out of 100, Not ready, 31 findings.`

## Gotchas

- `tests/e2e/screenreader.spec.ts` holds the full assertions, including the failed-read and screenshot focus cases.
- Playwright's `setInputFiles` does not focus the input; call `.focus()` first when the test is about focus.
