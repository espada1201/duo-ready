import { blockAt, type Block } from '../swift';
import { eolOf, lineAround } from '../text';
import { defineGroup, chainHas, declaredAt, matchBefore, PREPARE } from './engine';

const VIEWPORT_WIDTH = /viewport[^\n>]{0,160}?\bwidth\s*=\s*(\d{3,4})\b/g;
const viewportMessage = (width: string) => `The web viewport is fixed at ${width} px instead of device-width.`;
/** Callbacks that run when the window changes size. */
const ON_RESIZE = /\bfunc\s+(viewWillTransition|traitCollectionDidChange|viewWillLayoutSubviews|viewDidLayoutSubviews)\b|\.onChange\s*\(\s*of\s*:\s*\w*[sS]izeClass\b/g;

function inDrawFunc(m: string, scope: Block | null): boolean {
  for (let b = scope; b?.parent; b = b.parent) if (/\bfunc\s+draw\s*\([^{]*$/.test(m.slice(Math.max(0, b.open - 120), b.open))) return true;
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
      // Picking a keyboard type by idiom is about input, not layout.
      if (!declaredAt(m, hit.index!) && !/\bkeyboardType\b/.test(lineAround(m, hit.index!))) report('idiom-layout', hit.index!);
    }

    const scaled = m.includes('scaledFont');
    const drawing = /\bUIGraphicsPDFRenderer\b|\bUIGraphicsBeginPDFContext/.test(m);
    for (const hit of m.matchAll(/\.system\s*\(\s*size\s*:|\bUIFont\s*\.\s*(?:systemFont|boldSystemFont|italicSystemFont|monospacedSystemFont)\s*\(\s*ofSize\s*:|\bUIFont\s*\(\s*name\s*:[^)]*size\s*:|\.custom\s*\([^)]*size\s*:/g)) {
      if (/relativeTo\s*:|UIFontMetrics|scaledFont/.test(lineAround(m, hit.index!) + callText(m, hit.index!))) continue;
      // A point size on an SF Symbol sizes an icon; PDF and draw(_:) output has no Dynamic Type to follow.
      if (/\bImage\s*\(\s*systemName\s*:[^()]*\)(?:\s*\.\w+\s*\((?:[^()]|\([^()]*\))*\))*\s*\.font\s*\(\s*$/.test(m.slice(Math.max(0, hit.index! - 300), hit.index))) continue;
      if (drawing || inDrawFunc(m, blockAt(src.root, hit.index!))) continue;
      // `let f = UIFont(...)` later passed to `scaledFont(for: f)` scales too.
      const name = scaled && /\b(?:let|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*$/.exec(m.slice(Math.max(0, hit.index! - 60), hit.index))?.[1];
      const scope = blockAt(src.root, hit.index!);
      if (name && new RegExp(`scaledFont\\s*\\(\\s*for\\s*:\\s*${name}\\b`).test(m.slice(scope.open + 1, scope.close))) continue;
      report('fixed-font', hit.index!);
    }

    for (const hit of m.matchAll(/\.resizable\s*\(\s*\)/g)) {
      const end = hit.index! + hit[0].length;
      if (chainHas(m, end, /^(aspectRatio|scaledToFit|scaledToFill)$/)) continue;
      // A symbol or bundled asset (Image(name), Image(.resource), SwiftGen's .swiftUIImage) in a fixed square frame is an icon:
      // it neither distorts nor follows the window. Photos and avatars (uiImage:, AsyncImage) can be
      // any shape, so they still count.
      const icon = matchBefore(m, hit.index!, /(?:\bImage\s*\(\s*(?:(?:systemName|decorative)\s*:[^()]*|"[^"]*"|\.?[A-Za-z_][\w.]*)\s*\)|\.swiftUIImage)\s*$/) !== null;
      if (icon && chainHas(m, end, /^frame$/, /^\s*width\s*:\s*([^,]+?)\s*,\s*height\s*:\s*\1\s*(?:,|$)/)) continue;
      const indent = /\n([ \t]*)\.resizable/.exec(file.content.slice(Math.max(0, hit.index! - 200), end));
      // A full-bleed background should keep filling the window, not letterbox inside it.
      const scale = chainHas(m, end, /^(ignoresSafeArea|edgesIgnoringSafeArea)$/) ? '.scaledToFill()' : '.scaledToFit()';
      report('stretched-image', hit.index!, undefined, {
        confidence: 'review',
        description: 'Keep the image’s aspect ratio.',
        edits: [{ start: end, end, text: indent ? `${eolOf(file.content)}${indent[1]}${scale}` : scale }],
      });
    }
    for (const hit of m.matchAll(/\.contentMode\s*=\s*\.scaleToFill\b/g)) report('stretched-image', hit.index!);

    // HTML in string literals: the mask blanks it, so read the raw text inside strings.
    for (const hit of file.content.matchAll(VIEWPORT_WIDTH)) {
      const at = hit.index! + hit[0].length - hit[1].length;
      if (src.strings[at]) report('webview-viewport', hit.index!, viewportMessage(hit[1]));
    }
    for (const hit of m.matchAll(ON_RESIZE)) {
      const open = m.indexOf('{', hit.index!);
      const body = blocks.find((b) => b.open === open);
      const reload = body && /\.reload\s*\(\s*\)|\.loadHTMLString\s*\(|\.load\s*\(\s*URLRequest/.exec(m.slice(body.open, body.close));
      if (reload) report('webview-viewport', body.open + reload.index, 'Web content reloads when the size changes, so a fold throws away its scroll position and input.');
    }

    for (const hit of m.matchAll(/\bscaleMode\s*=\s*\.(fill|aspectFit)\b/g)) {
      report('game-aspect', hit.index!, hit[1] === 'fill' ? '.fill stretches the scene to the window’s shape.' : '.aspectFit leaves black bars on windows of another shape.');
    }
  },

  html({ file, report }) {
    for (const hit of file.content.matchAll(VIEWPORT_WIDTH)) {
      report('webview-viewport', hit.index!, viewportMessage(hit[1]));
    }
  },
});
