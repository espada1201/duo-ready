import { blockAt, type Block } from '../swift';
import { eolOf, lineAround } from '../text';
import { defineGroup, chainHas, closeOf, declaredAt, enclosingType, matchBefore, PREPARE } from './engine';

const VIEWPORT_WIDTH = /viewport[^\n>]{0,160}?\bwidth\s*=\s*(\d{3,4})\b/g;
const viewportMessage = (width: string) => `The web viewport is fixed at ${width} px instead of device-width.`;
/** Callbacks that run when the window changes size. */
const ON_RESIZE = /\bfunc\s+(viewWillTransition|traitCollectionDidChange|viewWillLayoutSubviews|viewDidLayoutSubviews)\b|\.onChange\s*\(\s*of\s*:\s*\w*[sS]izeClass\b/g;

const OFFSCREEN_RENDER = /\bUIPrint(?:PageRenderer|Formatter)\b|\bUIMarkupTextPrintFormatter\b|\bUIGraphicsPDFRenderer\b|\bUIGraphicsBeginPDFContext|\bUIGraphicsImageRenderer\b|\bUIGraphicsBeginImageContext/;

/** Inside draw(_:), a function or closure that renders a PDF or an image, or a type made for PDF or print output. */
function inDrawing(m: string, scope: Block | null): boolean {
  for (let b = scope; b?.parent; b = b.parent) {
    const head = m.slice(Math.max(0, b.open - 120), b.open);
    if (/\bfunc\s+draw\s*\([^{]*$/.test(head)) return true;
    const type = /\b(?:class|struct|enum|actor|extension)\s+(?!func\b|var\b|let\b)(\w+)[^{}]*$/.exec(head);
    if (type ? /PDF|Pdf|UIPrint/.test(type[0]) : OFFSCREEN_RENDER.test(m.slice(b.open, b.close)) || /\bUIGraphicsImageRenderer\b[^{}]*$/.test(head)) return true;
  }
  return false;
}

/** The text of the call starting at `from`, through its balanced closing parenthesis. */
function callText(masked: string, from: number): string {
  let depth = 0;
  for (let i = masked.indexOf('(', from); i !== -1 && i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return masked.slice(from, i + 1);
  }
  return masked.slice(from);
}

/** Lookahead: the next argument isn't read from a window, geometry or container (`.infinity`, `proxy.size.width`, `bounds.width`), which would follow the window. */
const NOT_DYNAMIC = String.raw`(?![^,]*(?:infinity|proxy|geo\w*|bounds|\.frame\b|container\w*|window\w*))`;
/** `width: 40, height: 40` or `width: Layout.icon, height: Layout.icon`: both set, neither dynamic. */
const FIXED_FRAME = new RegExp(String.raw`^\s*width\s*:\s*${NOT_DYNAMIC}(?:[^,()]|\([^()]*\))+,\s*height\s*:\s*${NOT_DYNAMIC}(?:[^,()]|\([^()]*\))+(?:,|$)`, 'i');
/** Modifiers that keep an image to its aspect ratio. */
/** `size: 20` for the project's own square(size:) modifiers. */
const FIXED_SIZE = new RegExp(String.raw`^\s*(?:size\s*:\s*)?${NOT_DYNAMIC}[^,]+(?:,|$)`);
const SMALL_IMAGE = /avatar|icon|thumb|badge|logo/i;
const KEEPS_ASPECT = /^(?:aspectRatio|scaledToFit|scaledToFill)$/;

/** Whether the function holding `scope` returns text or an icon (`-> String`, `-> SymbolName`, `-> UIImage?`). */
function returnsCopy(m: string, scope: Block | null): boolean {
  for (let b = scope; b?.parent; b = b.parent) {
    const head = /\bfunc\s+\w+\s*(?:<[^>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?:throws\s*)?(?:->\s*([\w.]+)\??)?\s*(?:where\s[^{]*)?$/.exec(m.slice(Math.max(0, b.open - 300), b.open));
    if (head) return /^(?:String|AttributedString|NSAttributedString|LocalizedStringKey|UIImage|Image|\w*Symbol\w*|\w*Icon\w*)$/.test(head[1] ?? '');
  }
  return false;
}

/** Whether a block around the image (`AsyncImage { image in … } placeholder: { … }`, a `Group`, a `switch`, KFImage's `.placeholder { }`) ends in a fixed frame or an aspect ratio. */
function sizedOutside(m: string, block: Block): boolean {
  for (let b: Block | null = block, depth = 0; b?.parent && depth < 3; b = b.parent, depth++) {
    let at = b.close + 1;
    // Skip the call's other labelled closures: `} placeholder: { … }`.
    for (let next; (next = /^\s*\w+\s*:\s*\{/.exec(m.slice(at, at + 80))); ) {
      const close = closeOf(m, at + next[0].length - 1);
      if (close < 0) break;
      at = close;
    }
    if (chainHas(m, at, /^frame$/, FIXED_FRAME) || chainHas(m, at, KEEPS_ASPECT)) return true;
  }
  return false;
}

export const stretched = defineGroup({
  id: 'stretched',
  title: 'Small or stretched elements',
  seen: 'Elements that look small or stretched on the big inner display.',
  cause: 'Layouts that pick a design from the device type, fixed font sizes, images without an aspect ratio, web pages pinned to a phone width and game scenes sized for one aspect ratio all assume the screen shapes of past iPhones.',
  rules: [
    {
      id: 'idiom-layout',
      title: 'Layout decided by device idiom',
      severity: 'warning',
      why: 'Duo is a phone idiom with an iPad-sized inner display. Idiom checks pick the phone layout on a tablet-sized canvas.',
      instead: 'Switch layouts on horizontalSizeClass / verticalSizeClass.',
      source: PREPARE,
    },
    {
      id: 'fixed-font',
      title: 'Fixed font size',
      severity: 'info',
      why: 'A fixed point size ignores Dynamic Type, the text size people choose in Settings, so the text stays the same size for someone who needs it larger.',
      instead: 'Use text styles (.body, .headline), Font.custom(_:size:relativeTo:) or UIFontMetrics.',
      source: 'Apple Human Interface Guidelines, Typography',
    },
    {
      id: 'stretched-image',
      title: 'Image can stretch',
      severity: 'warning',
      why: 'A resizable image with no aspect ratio fills whatever frame it gets. On Duo’s new window shapes that means stretched artwork.',
      instead: 'Add .scaledToFit() or .scaledToFill(), or use contentMode .scaleAspectFit.',
      source: 'Apple Human Interface Guidelines, Images',
    },
    {
      id: 'webview-viewport',
      title: 'Web content pinned to a phone width',
      severity: 'warning',
      why: 'A viewport fixed at an iPhone width makes web content render at that width and scale up on the inner display, so it looks blurry and oversized. Reloading web content on every size change throws away scroll position and form input each time the phone opens or closes.',
      instead: 'Use <meta name="viewport" content="width=device-width, initial-scale=1"> and let the page reflow; never reload a web view to handle a resize.',
      source: 'Apple Safari Web Content Guide, Configuring the Viewport',
    },
    {
      id: 'game-aspect',
      title: 'Game scene scaled for one aspect ratio',
      severity: 'warning',
      why: 'Duo’s windows run from a tall outer display to a nearly square inner one, and they change mid-game when the phone opens. A scene sized for one iPhone shape stretches with .fill and gets black bars with .aspectFit.',
      instead: 'Use .resizeFill and lay out in didChangeSize(_:), or .aspectFill with important content kept away from the edges.',
      source: 'Apple SpriteKit documentation (SKSceneScaleMode)',
    },
  ],

  swift({ file, src, masked: m, blocks, facts, report }) {
    if (facts.idiomWrappers.length) {
      for (const hit of m.matchAll(new RegExp(`\\.(${facts.idiomWrappers.join('|')})\\b(?!\\s*[:(])`, 'g'))) {
        if (!/\bkeyboardType\b/.test(lineAround(m, hit.index!))) report('idiom-layout', hit.index! + 1, `${hit[1]} is a device idiom check under another name.`);
      }
    }
    for (const hit of m.matchAll(/\buserInterfaceIdiom\b/g)) {
      const line = lineAround(m, hit.index!);
      // Picking a keyboard type by idiom is about input, not layout; a tvOS, Mac or CarPlay check is
      // false on Duo either way; and a wrapper like `isPad` is reported where it's used.
      // `userInterfaceIdiom: UIUserInterfaceIdiom = .phone` declares a parameter or property; its readers are what matter.
      if (declaredAt(m, hit.index!) || /^userInterfaceIdiom\s*:\s*UIUserInterfaceIdiom\b/.test(m.slice(hit.index!, hit.index! + 60)) || /\bkeyboardType\b|\bpreferredStyle\b/.test(line) || /^userInterfaceIdiom\s*[!=]=\s*\.(?:tv|mac|carPlay|vision)\b/.test(m.slice(hit.index!, hit.index! + 60))) continue;
      if (facts.idiomWrappers.some((w) => new RegExp(`\\bvar\\s+${w}\\s*:\\s*Bool\\s*\\{[^{}]*$`).test(m.slice(Math.max(0, hit.index! - 120), hit.index)))) continue;
      // A function that returns a name or an icon picks wording for the device, not a layout.
      if (returnsCopy(m, blockAt(src.root, hit.index!))) continue;
      report('idiom-layout', hit.index!);
    }

    const scaled = m.includes('scaledFont');
    for (const hit of m.matchAll(/\.system\s*\(\s*size\s*:|\bUIFont\s*\.\s*(?:systemFont|boldSystemFont|italicSystemFont|monospacedSystemFont)\s*\(\s*ofSize\s*:|\bUIFont\s*\(\s*name\s*:[^)]*size\s*:|\.custom\s*\([^)]*size\s*:/g)) {
      // A size read from a text style follows the reader's text size when the font is made.
      const call = callText(m, hit.index!);
      if (/relativeTo\s*:|UIFontMetrics|scaledFont/.test(lineAround(m, hit.index!) + call) || /forTextStyle|withTextStyle/.test(call)) continue;
      // `UIFont(name: "Avenir", size: 1)` only names the family; the size is set later.
      if (/\bsize\s*:\s*(?:0?\.\d+|[01](?:\.0+)?)\s*[,)]/.test(m.slice(hit.index!, hit.index! + hit[0].length + 20))) continue;
      // A point size on an SF Symbol sizes an icon; PDF and draw(_:) output has no Dynamic Type to follow.
      if (/\bImage\s*\(\s*system(?:Name|Symbol)\s*:[^()]*\)(?:\s*\.\w+\s*\((?:[^()]|\([^()]*\))*\))*\s*\.font\s*\(\s*$/.test(m.slice(Math.max(0, hit.index! - 300), hit.index))) continue;
      if (inDrawing(m, blockAt(src.root, hit.index!))) continue;
      // `let f = UIFont(...)` later passed to `scaledFont(for: f)` scales too.
      const name = scaled && /\b(?:let|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*$/.exec(m.slice(Math.max(0, hit.index! - 60), hit.index))?.[1];
      const scope = blockAt(src.root, hit.index!);
      if (name && new RegExp(`scaledFont\\s*\\(\\s*for\\s*:\\s*${name}\\b`).test(m.slice(scope.open + 1, scope.close))) continue;
      report('fixed-font', hit.index!);
    }

    // The project's own `square(size:)`-style modifiers frame an image the way `.frame(width: s, height: s)` does.
    const square = facts.squareModifiers.length ? new RegExp(`^(?:${facts.squareModifiers.join('|')})$`) : null;
    for (const hit of m.matchAll(/\.resizable\s*\(\s*\)/g)) {
      const end = hit.index! + hit[0].length;
      if (chainHas(m, end, KEEPS_ASPECT)) continue;
      const before = m.slice(Math.max(0, hit.index! - 300), hit.index);
      // A placeholder handed to a sized view (`AvatarView(diameter: 72, placeholderImage: Image("g").resizable())`) takes its frame there.
      if (/\b\w+\s*:\s*Image\s*\((?:[^()]|\([^()]*\))*\)\s*$/.test(before) && /^\s*[,)]/.test(m.slice(end, end + 200))) continue;
      // A blur-hash placeholder is meant to stretch; an image handed to a caller's closure gets its aspect there.
      if (matchBefore(m, hit.index!, /(?:\bImage\s*\(\s*blurHash\s*:[^()]*(?:\([^()]*\)[^()]*)*\)\??|(?:^|[^.\w])\w+\s*\(\s*Image\s*\((?:[^()]|\([^()]*\))*\))\s*$/) !== null) continue;
      // A fixed width and height (or the project's square(size:)) never follow the window, so Duo can't stretch the image any more than an iPhone does.
      if (square && chainHas(m, end, square, FIXED_SIZE)) continue;
      if (chainHas(m, end, /^frame$/, FIXED_FRAME) || chainHas(m, end, /^frame$/, /^\s*\.square\s*\(/) || sizedOutside(m, blockAt(src.root, hit.index!))) continue;
      // A view its callers keep to an aspect ratio (`ImageView(url: u).scaledToFit()`) can't stretch.
      if (facts.aspectViews.has(enclosingType(m, blockAt(src.root, hit.index!)) ?? '')) continue;
      // `.modifier(IconFrame(size: 24))`: a frame modifier the project wrote.
      if (chainHas(m, end, /^modifier$/, /^\s*\w*Frame\b/)) continue;
      const indent = /\n([ \t]*)\.resizable/.exec(file.content.slice(Math.max(0, hit.index! - 200), end));
      // A full-bleed background should keep filling the window, not letterbox inside it.
      const scale = chainHas(m, end, /^(ignoresSafeArea|edgesIgnoringSafeArea)$/) ? '.scaledToFill()' : '.scaledToFit()';
      report('stretched-image', hit.index!, undefined, {
        confidence: 'review',
        description: 'Keep the image’s aspect ratio.',
        edits: [{ start: end, end, text: indent ? `${eolOf(file.content)}${indent[1]}${scale}` : scale }],
      });
    }
    for (const hit of m.matchAll(/\.contentMode\s*=\s*\.scaleToFill\b/g)) {
      // Avatars, icons and thumbnails sit in fixed square frames: named on the line, just above it, or by the view type.
      const before = m.slice(Math.max(0, hit.index! - 200), hit.index).split('\n').slice(-3).join('\n');
      if (SMALL_IMAGE.test(lineAround(m, hit.index!) + before + (enclosingType(m, blockAt(src.root, hit.index!)) ?? ''))) continue;
      report('stretched-image', hit.index!);
    }

    // HTML in string literals: the mask blanks it, so read the raw text inside strings.
    for (const hit of file.content.matchAll(VIEWPORT_WIDTH)) {
      const at = hit.index! + hit[0].length - hit[1].length;
      // HTML in a Swift string only reaches a viewport through a web view.
      if (src.strings[at] && /\b(?:WKWebView|UIWebView|loadHTMLString|SFSafariViewController)\b/.test(m)) report('webview-viewport', hit.index!, viewportMessage(hit[1]));
    }
    for (const hit of m.matchAll(ON_RESIZE)) {
      const open = m.indexOf('{', hit.index!);
      // A protocol requirement has no body: the next brace belongs to something else.
      if (/\bfunc\b|[};]/.test(m.slice(hit.index! + 4, open))) continue;
      const body = blocks.find((b) => b.open === open);
      // `listController.reload()` refreshes a list; only a web view's reload loses a page.
      const reload = body && /\b\w*[wW]eb\w*\??\.reload\s*\(\s*\)|\.loadHTMLString\s*\(|\.load\s*\(\s*URLRequest/.exec(m.slice(body.open, body.close));
      if (reload) report('webview-viewport', body.open + reload.index, 'Web content reloads when the size changes, so a fold throws away its scroll position and input.');
    }

    for (const hit of m.matchAll(/\bscaleMode\s*=\s*(?:SKSceneScaleMode)?\.(fill|aspectFit)\b/g)) {
      report('game-aspect', hit.index!, hit[1] === 'fill' ? '.fill stretches the scene to the window’s shape.' : '.aspectFit leaves black bars on windows of another shape.');
    }
  },

  objc({ masked: m, report }) {
    for (const hit of m.matchAll(/\buserInterfaceIdiom\b|\bUI_USER_INTERFACE_IDIOM\s*\(\s*\)/g)) {
      // A tvOS, Mac or CarPlay check is false on Duo either way; a keyboard type is about input.
      const after = m.slice(hit.index! + hit[0].length, hit.index! + hit[0].length + 60);
      if (/^\s*\]?\s*[!=]=\s*UIUserInterfaceIdiom(?:TV|Mac|CarPlay|Vision)\b/.test(after) || /\bkeyboardType\b|\bpreferredStyle\b/.test(lineAround(m, hit.index!))) continue;
      report('idiom-layout', hit.index!);
    }
    for (const hit of m.matchAll(/\b(?:systemFontOfSize|boldSystemFontOfSize|italicSystemFontOfSize|monospacedSystemFontOfSize|fontWithName)\s*:/g)) {
      if (/@selector\s*\(\s*$/.test(m.slice(Math.max(0, hit.index! - 20), hit.index))) continue;
      // The rest of the message, so a size on the next line or a nested [self fontName] is still read.
      const end = m.indexOf(';', hit.index!);
      const statement = m.slice(hit.index!, Math.min(end < 0 ? m.length : end, hit.index! + 400));
      if (hit[0].startsWith('fontWithName') && !/\bsize\s*:/.test(statement)) continue;
      if (/UIFontMetrics|scaledFontForFont/.test(lineAround(m, hit.index!)) || /UIFontTextStyle|ForTextStyle|UIFontMetrics|scaledFontForFont/.test(statement)) continue;
      report('fixed-font', hit.index!);
    }
    for (const hit of m.matchAll(/\bUIViewContentModeScaleToFill\b/g)) report('stretched-image', hit.index!);
    for (const hit of m.matchAll(/\bSKSceneScaleMode(Fill|AspectFit)\b/g)) {
      report('game-aspect', hit.index!, hit[1] === 'Fill' ? 'SKSceneScaleModeFill stretches the scene to the window’s shape.' : 'SKSceneScaleModeAspectFit leaves black bars on windows of another shape.');
    }
  },

  html({ file, report }) {
    for (const hit of file.content.matchAll(VIEWPORT_WIDTH)) {
      report('webview-viewport', hit.index!, viewportMessage(hit[1]));
    }
  },
});
