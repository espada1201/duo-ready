import { eolOf, lineIndent } from '../text';
import { labelOffset } from '../swift';
import { afterModifiers, PREPARE, type RuleGroup } from './engine';

export const misplaced: RuleGroup = {
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

  swift({ file, src, masked: m, blocks, report }) {
    // `UINavigationBar().bounds` only measures a default bar.
    for (const hit of m.matchAll(/\b(UITabBar|UIToolbar|UINavigationBar)\s*\((?!\s*\)\s*\.)/g)) {
      report('hand-built-bar', hit.index!, `${hit[1]} created by hand won’t get Duo’s vertical bar layout.`);
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
      const modifiers = m.slice(b.close + 1, afterModifiers(m, b.close + 1));
      // A paged TabView is a carousel, not tabs.
      if (/\.defaultTabBarPlacement\b|\.sidebarAdaptable\b|\.tabViewStyle\s*\(\s*(?:\.page|PageTabViewStyle)\b/.test(modifiers)) continue;
      report('tab-sidebar', labelOffset(src, b), undefined, {
        confidence: 'review',
        description: 'Show tabs as a sidebar on the inner display. Needs the iOS 27.1 SDK; behind an availability check if you deploy to earlier iOS.',
        edits: [{ start: b.close + 1, end: b.close + 1, text: `${eolOf(file.content)}${lineIndent(file.content, b.open)}.defaultTabBarPlacement(.sidebar)` }],
      });
    }

    for (const hit of m.matchAll(/\bUIScreenEdgePanGestureRecognizer\s*\(/g)) report('edge-gesture', hit.index!);
  },
};
