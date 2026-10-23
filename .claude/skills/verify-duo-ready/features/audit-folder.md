# Audit a chosen folder

Choosing a project folder reads its Swift, Info.plist, Xcode project and HTML in the browser. Paths start inside the chosen folder, so a project kept in a folder named `build` still audits.

## Sub-features

- `folder-pick` audits a folder chosen with the file picker.
- `folder-empty` explains a folder with nothing to audit.
- `zip-pick` audits a .zip of the project; its single top folder and macOS `__MACOSX` junk are ignored.

## How to get to it (user POV)

- On `#audit`, choose `Choose folder`, or drop a folder on the drop zone.

## Driving it with verify.mjs

Preconditions: a temporary copy of `sample/Encore` in a folder named `build`.

- **Pick.** Set `folder-input` to that folder. 31 `.finding` items render, and `.eyebrow` reads `build`, the chosen folder's name (`Chosen folder` only when the browser gives no folder name; a zip uses its file name).
- **Zip.** Zip that folder with `zip -qr`, set `zip-input` to it. 31 `.finding` items render.

## Gotchas

- Drag and drop can't be driven by Playwright's file input. It shares `readEntries` with no automated coverage, so test it by hand after changes there.
