import { blockAt, declaredTypes, headerOf, labelOffset, type Block, type SwiftSource } from '../swift';
import type { Fix } from '../types';
import { PREPARE, type RuleGroup } from './engine';

const SCENES = 'Apple, WWDC25 “Make your UIKit app more flexible” (UIScene required after iOS 26)';

const UIKIT_VIEWS = /^UI(View|Control|Button|Label|ImageView|ScrollView|TableView|CollectionView|StackView|TextField|TextView|VisualEffectView|TableViewCell|CollectionViewCell|CollectionReusableView|TableViewHeaderFooterView)$/;
const UIKIT_CONTROLLERS = /^UI(ViewController|TableViewController|CollectionViewController|NavigationController|TabBarController|SplitViewController|PageViewController)$/;
const CONTROL_FLOW = /^(\}\s*)?(if|else|guard|for|while|switch|do|repeat|defer|catch)\b/;

/**
 * Whether `offset` sits in an instance method of a UIKit view or view controller, where
 * `traitCollection`, `bounds` and `view` resolve to the instance. Anything less certain
 * (closures, initializers, static members, property initializers, unknown superclasses)
 * returns null so no fix is offered.
 */
function uikitContext(src: SwiftSource, offset: number): 'controller' | 'view' | null {
  let b: Block | null = blockAt(src.root, offset);
  while (b && b.parent && CONTROL_FLOW.test(headerOf(src, b))) b = b.parent;
  if (!b || !b.parent) return null;
  if (!/^(@\w+\s+)*((public|private|fileprivate|internal|open|final|override|@objc|mutating|nonisolated)\s+)*func\s/.test(headerOf(src, b))) return null;
  const owner = declaredTypes(src).find((t) => t.block === b!.parent);
  const base = owner?.inherits[0] ?? '';
  if (UIKIT_CONTROLLERS.test(base)) return 'controller';
  if (UIKIT_VIEWS.test(base)) return 'view';
  return null;
}

/**
 * Number of top-level statements in a builder body. Lines starting with `.` continue the
 * previous statement (modifier chains); anything ambiguous counts as another statement.
 */
function countStatements(body: string): number {
  let count = 0;
  let depth = 0;
  let open = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (depth === 0 && !(open && trimmed.startsWith('.'))) count++;
    for (const c of line) {
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      else if (c === ';' && depth === 0) count++;
    }
    open = true;
  }
  return count;
}

const isPortraitOnly = (orientations: string[]) => orientations.length > 0 && orientations.every((o) => o.includes('Portrait'));

export const fold: RuleGroup = {
  id: 'fold',
  title: 'Breaks when you fold or unfold',
  seen: 'Reviewers praise how Apple’s own apps carry on mid-task when you open or close the phone. Third-party apps only do the same if they are built for it.',
  cause: 'A fold is a live resize across two displays. Apps that read “the” screen or window, decide layout from orientation, or rebuild views on size class lose their place.',
  rules: [
    {
      id: 'state-reset',
      title: 'State resets when the phone opens or closes',
      severity: 'warning',
      why: 'Opening or closing Duo changes the size class mid-task. Views swapped on size class, or given a fresh .id, are rebuilt and lose their @State: scroll position, typed text, playback.',
      instead: 'Keep one view and change only its layout with AnyLayout or ViewThatFits; keep what matters in @SceneStorage.',
      source: PREPARE,
    },
    {
      id: 'uiscreen-main',
      title: 'UIScreen.main on a two-display phone',
      severity: 'error',
      why: 'iPhone Duo has two displays, so “the main screen” is ambiguous. UIScreen.main is deprecated, and Apple says to remove it.',
      instead: 'Read scale from traitCollection.displayScale and sizes from your view or window scene.',
      source: PREPARE,
    },
    {
      id: 'key-window',
      title: 'Assumes a single window',
      severity: 'warning',
      why: 'Duo runs scenes on two displays. The key window or first scene may be on the other display, so sheets, alerts and sizes land in the wrong place.',
      instead: 'Use the window and scene of the view you are working in (view.window, view.window?.windowScene).',
      source: PREPARE,
    },
    {
      id: 'orientation-layout',
      title: 'Layout decided by orientation',
      severity: 'error',
      why: 'The inner display does not honor supported interface orientations, so orientation no longer predicts the canvas shape. Layout keyed to it is wrong on the inner display every time.',
      instead: 'Use size classes and the container’s own size.',
      source: PREPARE,
    },
    {
      id: 'portrait-only',
      title: 'Portrait-only app',
      severity: 'error',
      why: 'The inner display ignores your orientation lock, so a layout that only works upright gets a landscape canvas anyway.',
      instead: 'Support landscape on iPhone.',
      source: PREPARE,
      project: true,
    },
    {
      id: 'no-scene-lifecycle',
      title: 'App does not use the scene lifecycle',
      severity: 'error',
      why: 'Duo runs scenes on two displays, and Apple requires the UIScene lifecycle in releases after iOS 26.',
      instead: 'Add UIApplicationSceneManifest and a UIWindowSceneDelegate, or use a SwiftUI App.',
      source: SCENES,
    },
    {
      id: 'navigation-view',
      title: 'Deprecated NavigationView',
      severity: 'info',
      why: 'NavigationStack and NavigationSplitView are the containers Apple adapts to the fold: columns collapse when closed and tile when open.',
      instead: 'Use NavigationStack for one column, NavigationSplitView for list and detail.',
      source: PREPARE,
    },
  ],

  swift({ src, masked: m, blocks, facts, report }) {
    for (const hit of m.matchAll(/\bUIScreen\s*\.\s*main\b(\s*\.\s*(scale|bounds|nativeScale)\b)?/g)) {
      const ctx = uikitContext(src, hit.index!);
      const member = hit[2];
      const span = { start: hit.index!, end: hit.index! + hit[0].length };
      let fix: Fix | undefined;
      if (member === 'scale' && ctx) {
        fix = {
          confidence: 'review',
          description: 'Use the trait collection’s display scale. Read it once the view is in a window.',
          edits: [{ ...span, text: 'traitCollection.displayScale' }],
        };
      } else if (member === 'bounds' && ctx) {
        fix = {
          confidence: 'review',
          description: ctx === 'controller' ? 'Size from the view controller’s view.' : 'Size from this view’s bounds.',
          edits: [{ ...span, text: ctx === 'controller' ? 'view.bounds' : 'bounds' }],
        };
      }
      report('uiscreen-main', hit.index!, member ? `UIScreen.main.${member} is ambiguous on a two-display phone.` : undefined, fix);
    }

    for (const hit of m.matchAll(/\bUIDevice\s*\.\s*current\s*\.\s*orientation(?:\s*\.\s*is(?:Landscape|Portrait))?\b|\binterfaceOrientation\b|\bstatusBarOrientation\b|\.isLandscape\b|\.isPortrait\b/g)) {
      report('orientation-layout', hit.index!);
    }

    // Swapping view types on size class rebuilds them, so @State is lost on fold.
    for (const b of blocks) {
      const sibling = b.parent?.children[b.parent.children.indexOf(b) + 1];
      const head = m.slice(Math.max(0, b.open - 80), b.open);
      const cond = /\bif\s+\w*[sS]izeClass\w*\s*[!=]=\s*\.\w+\s*$/.exec(head);
      if (cond && sibling && headerOf(src, sibling) === 'else') report('state-reset', b.open - head.length + cond.index);
    }
    for (const hit of m.matchAll(/\.id\s*\(\s*UUID\s*\(\s*\)\s*\)/g)) {
      report('state-reset', hit.index!, '.id(UUID()) gives the view a new identity on every update, so its state never survives a fold.');
    }

    for (const hit of m.matchAll(/\bUIApplication\s*\.\s*shared\s*\.\s*(windows|keyWindow|connectedScenes\s*\.\s*first|delegate\s*\??\s*\.\s*window)\b/g)) {
      report('key-window', hit.index!);
    }

    for (const b of blocks) {
      if (b.label !== 'NavigationView' || b.argument) continue;
      const at = labelOffset(src, b);
      const target = facts.deploymentTarget;
      const edits = [{ start: at, end: at + 'NavigationView'.length, text: 'NavigationStack' }];
      if (countStatements(m.slice(b.open + 1, b.close)) !== 1) report('navigation-view', at);
      else if (target !== null && target < 16) {
        report('navigation-view', at, `NavigationStack needs iOS 16 and this project deploys to iOS ${target}. Switch when you raise the deployment target.`);
      } else {
        report(
          'navigation-view',
          at,
          undefined,
          target === null
            ? { confidence: 'review', description: 'Replace with NavigationStack. Needs iOS 16 or later; no Xcode project was given to check.', edits }
            : { confidence: 'safe', description: 'Replace with NavigationStack.', edits },
        );
      }
    }
  },

  plist({ plist, report }) {
    const orientations = plist.keys.get('UISupportedInterfaceOrientations~iphone') ?? plist.keys.get('UISupportedInterfaceOrientations');
    const list = orientations?.value;
    if (orientations && Array.isArray(list) && list.every((v) => typeof v === 'string') && isPortraitOnly(list as string[])) {
      report('portrait-only', orientations.offset);
    }
  },

  pbxproj({ file, report }) {
    const seen = new Set<string>();
    for (const hit of file.content.matchAll(/INFOPLIST_KEY_UISupportedInterfaceOrientations(?:_iPhone)?\s*=\s*"?([^";]*)"?;/g)) {
      const value = hit[1].trim();
      if (!value || seen.has(value) || !isPortraitOnly(value.split(/\s+/))) continue;
      seen.add(value);
      report('portrait-only', hit.index!);
    }
  },

  project({ facts, reporterFor }) {
    const usesScenes = facts.swiftUIApp || (facts.sceneManifest && facts.sceneDelegate);
    if (!usesScenes && facts.appDelegate) reporterFor(facts.appDelegate.file)('no-scene-lifecycle', facts.appDelegate.offset);
  },
};
