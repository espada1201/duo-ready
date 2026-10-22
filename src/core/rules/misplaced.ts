import { eolOf, lineAround, lineIndent } from '../text';
import { blockAt, labelOffset, type Block } from '../swift';
import { defineGroup, chainHas, PREPARE } from './engine';

/** The sidebar modifier, kept to iOS when the project also builds for platforms that lack it. */
function sidebar(eol: string, indent: string, otherPlatforms: boolean, lineEnds: boolean): string {
  const modifier = `${eol}${indent}.defaultTabBarPlacement(.sidebar)`;
  if (!otherPlatforms) return modifier;
  // `#endif` must stand alone, so a modifier that followed the brace moves to the next line.
  return `${eol}${indent}#if os(iOS)${modifier}${eol}${indent}#endif${lineEnds ? '' : `${eol}${indent}`}`;
}

function insideExtensionOf(m: string, scope: Block | null, type: string): boolean {
  for (let b = scope; b?.parent; b = b.parent) if (new RegExp(`\\bextension\\s+${type}\\b[^{}]*$`).test(m.slice(Math.max(0, b.open - 120), b.open))) return true;
  return false;
}

export const misplaced = defineGroup({
  id: 'misplaced',
  title: 'Misplaced buttons and bars',
  seen: 'Buttons and bars in the wrong place or colliding with the status bar. MKBHD also pointed out that the inner display puts the status bar and system bars in a column on the right, which suits right-handed use better than left.',
  cause: 'Duo moves the status bar to the side and turns system bars vertical. Only system-owned bars follow, so they stay where people expect them; hand-made bars and symmetric inset math don’t know the edges changed.',
  rules: [
    {
      id: 'hand-built-bar',
      title: 'Hand-built tab bar, toolbar or navigation bar',
      severity: 'warning',
      why: 'Only bars owned by system containers move to Duo’s vertical layout. Custom bars stay put and collide with the status bar and camera.',
      instead: 'Use TabView / NavigationStack toolbars, or place custom bars with the reserved regions API.',
      source: PREPARE,
    },
    {
      id: 'symmetric-safe-area',
      title: 'Assumes left and right safe areas match',
      severity: 'warning',
      why: 'Duo’s vertical bars and side status bar make safe-area insets asymmetric; doubling one side clips or misaligns content.',
      instead: 'Inset by the full safe area: bounds.inset(by: safeAreaInsets).',
      source: PREPARE,
    },
    {
      id: 'tab-sidebar',
      title: 'TabView without a sidebar on the inner display',
      severity: 'info',
      why: 'On the inner display a sidebar uses the width better than a bottom tab bar.',
      instead: 'Opt in with .defaultTabBarPlacement(.sidebar) (iOS 27.1 SDK).',
      source: PREPARE,
    },
    {
      id: 'edge-gesture',
      title: 'Screen-edge swipe',
      severity: 'info',
      why: 'On the inner display the trailing edge holds the status bar and vertical system bars, and the fold adds a new edge in the middle. Edge swipes there fight the system.',
      instead: 'Prefer standard navigation gestures; if you need an edge pan, test it in every pose.',
      source: PREPARE,
    },
  ],

  objc({ masked: m, report }) {
    for (const hit of m.matchAll(/\[\s*(?:\[\s*(UITabBar|UIToolbar|UINavigationBar)\s+alloc\s*\]|(UITabBar|UIToolbar|UINavigationBar)\s+new\s*\])/g)) {
      if (!/inputAccessoryView/.test(lineAround(m, hit.index!))) report('hand-built-bar', hit.index!, `${hit[1] ?? hit[2]} created by hand won’t get Duo’s vertical bar layout.`);
    }
    for (const hit of m.matchAll(/safeAreaInsets\s*\.\s*(left|right|top|bottom)\s*\*\s*2(?![.\w])/g)) report('symmetric-safe-area', hit.index!);
    for (const hit of m.matchAll(/\[\s*UIScreenEdgePanGestureRecognizer\s+alloc\b/g)) report('edge-gesture', hit.index!);
  },

  swift({ file, src, masked: m, blocks, facts, report }) {
    // `UINavigationBar().bounds` only measures a default bar.
    for (const hit of m.matchAll(/\b(UITabBar|UIToolbar|UINavigationBar)\s*\((?!\s*\)\s*\.)/g)) {
      // A toolbar above the keyboard (inputAccessoryView) is not a screen's bar.
      const name = /\b(?:let|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*$/.exec(m.slice(Math.max(0, hit.index! - 60), hit.index))?.[1];
      if (/inputAccessoryView\s*=\s*$/.test(m.slice(Math.max(0, hit.index! - 40), hit.index))) continue;
      const scope = blockAt(src.root, hit.index!);
      if (name && new RegExp(`inputAccessoryView\\s*=\\s*${name}\\b`).test(m.slice(scope.open + 1, scope.close))) continue;
      // A factory in `extension UIToolbar` makes bars for its callers, which decide where they go.
      if (insideExtensionOf(m, scope, hit[1])) continue;
      report('hand-built-bar', hit.index!, `${hit[1] ?? hit[2]} created by hand won’t get Duo’s vertical bar layout.`);
    }
    for (const hit of m.matchAll(/\bstruct\s+(\w*(?:TabBar|Toolbar|NavBar|NavigationBar|BottomBar)(?:View)?)\s*:\s*[^{]*\bView\b/g)) {
      report('hand-built-bar', hit.index!, `${hit[1]} is a custom bar; it will stay horizontal while system bars go vertical.`);
    }

    const symmetric = /\b([A-Za-z_][\w.]*?)\.bounds\.(width|height)\s*-\s*\1\.safeAreaInsets\.(left|right|top|bottom)\s*\*\s*2(?![.\w])/g;
    const fixedSymmetric = new Set<number>();
    for (const hit of m.matchAll(symmetric)) {
      const axisOk = (hit[2] === 'width') === (hit[3] === 'left' || hit[3] === 'right');
      // Only rewrite a standalone `a - b * 2`: a neighbouring * / - % would re-associate.
      const before = m.slice(0, hit.index!).trimEnd().slice(-1);
      const after = m.slice(hit.index! + hit[0].length).trimStart()[0] ?? '';
      if (!axisOk || /[*/%\w)\].-]/.test(before) || /[*/%.]/.test(after)) continue;
      fixedSymmetric.add(hit.index! + hit[0].indexOf('safeAreaInsets'));
      report('symmetric-safe-area', hit.index!, undefined, {
        confidence: 'safe',
        description: 'Inset by every side of the safe area.',
        edits: [{ start: hit.index!, end: hit.index! + hit[0].length, text: `${hit[1]}.bounds.inset(by: ${hit[1]}.safeAreaInsets).${hit[2]}` }],
      });
    }
    for (const hit of m.matchAll(/safeAreaInsets\.(left|right|top|bottom)\s*\*\s*2(?![.\w])/g)) {
      if (!fixedSymmetric.has(hit.index!)) report('symmetric-safe-area', hit.index!);
    }

    for (const b of blocks) {
      if (b.label !== 'TabView' || b.argument) continue;
      // A paged TabView is a carousel, not tabs.
      if (chainHas(m, b.close + 1, /^defaultTabBarPlacement$/) || chainHas(m, b.close + 1, /^tabViewStyle$/, /^\s*(?:\.sidebarAdaptable|\.page|PageTabViewStyle)\b/)) continue;
      report('tab-sidebar', labelOffset(src, b), undefined, {
        confidence: 'review',
        description: 'Show tabs as a sidebar on the inner display. Needs the iOS 27.1 SDK; behind an availability check if you deploy to earlier iOS.',
        edits: [{ start: b.close + 1, end: b.close + 1, text: sidebar(eolOf(file.content), lineIndent(file.content, b.open), facts.otherPlatforms, /^[ \t]*(?:\r?\n|$)/.test(file.content.slice(b.close + 1))) }],
      });
    }

    for (const hit of m.matchAll(/\bUIScreenEdgePanGestureRecognizer\s*\(/g)) report('edge-gesture', hit.index!);
  },
});
