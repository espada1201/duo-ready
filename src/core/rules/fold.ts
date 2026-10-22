import { blockAt, declaredTypes, headerOf, labelOffset, type Block, type SwiftSource } from '../swift';
import type { Fix } from '../types';
import { lineAround } from '../text';
import { chainRoot, defineGroup, chainHas, closeOf, declaredAt, matchBefore, PREPARE, sizeClassPattern } from './engine';

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
function uikitContext(src: SwiftSource, offset: number): { kind: 'controller' | 'view'; func: string } | null {
  let b: Block | null = blockAt(src.root, offset);
  while (b && b.parent && CONTROL_FLOW.test(headerOf(src, b))) b = b.parent;
  if (!b || !b.parent) return null;
  const func = headerOf(src, b);
  if (!/^(@\w+\s+)*((public|private|fileprivate|internal|open|final|override|@objc|mutating|nonisolated)\s+)*func\s/.test(func)) return null;
  const owner = declaredTypes(src).find((t) => t.block === b!.parent);
  const base = owner?.inherits[0] ?? '';
  if (UIKIT_CONTROLLERS.test(base)) return { kind: 'controller', func };
  if (UIKIT_VIEWS.test(base)) return { kind: 'view', func };
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

/** Each target configuration's build settings, leaving out watchOS and extension targets. */
function iPhoneBuildSettings(pbxproj: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  if (!/buildSettings\s*=/.test(pbxproj)) return [{ text: pbxproj, offset: 0 }];
  for (const hit of pbxproj.matchAll(/buildSettings\s*=\s*\{([^}]*)\}/g)) {
    if (/SDKROOT\s*=\s*watchos|WATCHOS_DEPLOYMENT_TARGET|INFOPLIST_KEY_WK|APPLICATION_EXTENSION_API_ONLY\s*=\s*YES/.test(hit[1])) continue;
    out.push({ text: hit[1], offset: hit.index! + hit[0].indexOf('{') + 1 });
  }
  return out;
}

const isPortraitOnly = (orientations: string[]) => orientations.length > 0 && orientations.every((o) => o.includes('Portrait'));

// Rotating camera output or reporting a sensor reads orientation for a reason that isn't layout.
/** Built-in views that keep scroll position, focus, input or playback, which a rebuild resets. */
const STATEFUL = /^(?:TextField|SecureField|TextEditor|ScrollView|ScrollViewReader|List|Form|NavigationStack|NavigationSplitView|NavigationView|TabView|VideoPlayer|Map|Picker|DatePicker|Slider|Stepper|Toggle|Lazy\w+|WebView|PhotosPicker)$/;
/** Built-in views with nothing of their own to lose. */
const STATELESS = /^(?:View|Text|Image|Label|Spacer|Divider|Color|Rectangle|RoundedRectangle|Circle|Capsule|HStack|VStack|ZStack|Group|ProgressView|Button|Link|AnyView|EmptyView|ViewThatFits|GeometryReader|Font|CGFloat|CGSize|EdgeInsets|LinearGradient)$/;

/** A type from another module that is named like a view, so it may hold state we can't see. */
const VIEW_NAME = /(?:View|Field|Editor|Player|Picker|List|Grid|Sheet|Screen|Page|Form)$/;

/** The capitalised calls in `code`: views, mostly, and some initialisers. */
export const callsIn = (code: string) => [...code.matchAll(/\b([A-Z]\w*)\s*[({]/g)].map((c) => c[1]);

/** Whether the views called in `code` keep state: a stateful built-in, a project view that does, or a view from elsewhere. */
export function keepsState(code: string, views: Map<string, boolean>, file = '', depth = 0): boolean {
  // Content passed in (`content: content`) could hold anything.
  if (/\bcontent\s*:\s*[a-z]\w*\s*[,)]/.test(code)) return true;
  // A view built elsewhere (`cashButton()`, `regularHeaderView`) is read from this file's own `func` or `var`, if it's there.
  for (const hit of code.matchAll(/(?<![.\w])([a-z]\w*)\s*\(\s*\)|^\s*([a-z]\w*)\s*$|\{\s*([a-z]\w*)\s*\}/gm)) {
    const body = depth < 3 ? memberBody(file, hit[1] ?? hit[2] ?? hit[3]) : null;
    if (body === null || keepsState(body, views, file, depth + 1)) return true;
  }
  return callsIn(code).some((v) => STATEFUL.test(v) || (!STATELESS.test(v) && (views.get(v) ?? VIEW_NAME.test(v))));
}

const memberCache = new Map<string, Map<string, string>>();

/** The body of `var name: some View { … }` or `func name(…) -> some View { … }` in `masked`, from a per-file index. */
function memberBody(masked: string, name: string): string | null {
  let members = memberCache.get(masked);
  if (!members) {
    members = new Map();
    for (const head of masked.matchAll(/\b(?:var\s+(\w+)\s*:\s*some\s+View|func\s+(\w+)\s*\([^)]*\)\s*->\s*some\s+View)\s*\{/g)) {
      const open = head.index! + head[0].length - 1;
      const close = closeOf(masked, open);
      const key = head[1] ?? head[2];
      if (close > 0 && !members.has(key)) members.set(key, masked.slice(open + 1, close - 1));
    }
    // One file at a time is all a rule pass needs.
    memberCache.clear();
    memberCache.set(masked, members);
  }
  return members.get(name) ?? null;
}

/** Marks each project view stateful when it declares state, uses a stateful built-in, or shows a view that is. */
export function resolveViews(own: Map<string, { state: boolean; calls: string[] }>): Map<string, boolean> {
  const views = new Map([...own].map(([name, v]) => [name, v.state || v.calls.some((c) => STATEFUL.test(c))]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, v] of own) {
      if (views.get(name) || !v.calls.some((c) => views.get(c) ?? (!STATELESS.test(c) && !own.has(c) && VIEW_NAME.test(c)))) continue;
      views.set(name, true);
      changed = true;
    }
  }
  return views;
}

const CAMERA_FILE = /\b(videoOrientation|videoRotationAngle)\b/;
const NOT_LAYOUT = /AVCapture|XCUI|videoOrientation|videoRotation|rawValue|imageOrientation|CGImagePropertyOrientation|\w*OrientationAtPresentation|orientationAtPresentation|preferred\w*Orientation\w*|requestGeometryUpdate/;
/** The flagged line and the one before it, where `var preferredLandscapeOrientation: UIInterfaceOrientation {` names what a value is for. */
const withLineBefore = (m: string, at: number): string => {
  const start = m.lastIndexOf('\n', at - 1);
  return lineAround(m, at) + (start > 0 ? lineAround(m, start - 1) : '');
};

export const fold = defineGroup({
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
    for (const hit of m.matchAll(/\bUIScreen\s*\.\s*main\b(\s*\.\s*(scale|bounds|nativeScale|brightness)\b)?/g)) {
      const ctx = uikitContext(src, hit.index!);
      const member = hit[2];
      const span = { start: hit.index!, end: hit.index! + hit[0].length };
      let fix: Fix | undefined;
      let message: string | undefined;
      if (member === 'brightness') {
        message = 'UIScreen.main.brightness may change the display the app isn’t on. Use the screen of the view’s window scene: view.window?.windowScene?.screen.';
      } else if (member === 'scale' && ctx) {
        fix = {
          confidence: 'review',
          description: 'Use the trait collection’s display scale. Read it once the view is in a window.',
          edits: [{ ...span, text: 'self.traitCollection.displayScale' }],
        };
      } else if (member === 'bounds' && ctx && /\bloadView\s*\(/.test(ctx.func)) {
        // `self.view` inside loadView calls loadView again.
        message = 'UIScreen.main.bounds is ambiguous on a two-display phone. In loadView the view doesn’t exist yet: create it with any frame and let Auto Layout or viewDidLayoutSubviews size it.';
      } else if (member === 'bounds' && ctx && /\bviewWillTransition\s*\(/.test(ctx.func)) {
        // Mid-transition the view still has its old bounds: the new size is the parameter.
        message = 'UIScreen.main.bounds is ambiguous on a two-display phone. In viewWillTransition(to:with:), use the size parameter.';
      } else if (member === 'bounds' && ctx && !/[=!<>]=|\s[<>]\s/.test(lineAround(m, hit.index!))) {
        // In a comparison the other side is often the view's own size, and the rewrite would always be true.
        fix = {
          confidence: 'review',
          description: ctx.kind === 'controller' ? 'Size from the view controller’s view.' : 'Size from this view’s bounds.',
          // Explicit self, so a parameter or local named `view` or `bounds` can't capture it.
          edits: [{ ...span, text: ctx.kind === 'controller' ? 'self.view.bounds' : 'self.bounds' }],
        };
      }
      report('uiscreen-main', hit.index!, message ?? (member ? `UIScreen.main.${member} is ambiguous on a two-display phone.` : undefined), fix);
    }

    const cameraFile = CAMERA_FILE.test(m);
    for (const hit of m.matchAll(/\bUIDevice\s*\.\s*current\s*\.\s*orientation(?:\s*\.\s*is(?:Landscape|Portrait))?\b|\binterfaceOrientation\b|\bstatusBarOrientation\b|\b\w*[oO]rientation\s*\.\s*is(?:Landscape|Portrait)\b/g)) {
      if (cameraFile || NOT_LAYOUT.test(withLineBefore(m, hit.index!))) continue;
      // `interfaceOrientation previous: UIInterfaceOrientation` in a delegate signature is a parameter.
      if (declaredAt(m, hit.index!) || /^\w+(?:\s+\w+)?\s*:\s*UIInterfaceOrientation\b/.test(m.slice(hit.index!, hit.index! + 80))) continue;
      report('orientation-layout', hit.index!);
    }

    // Swapping view types on size class rebuilds them, so @State is lost on fold.
    const sizeCheck = new RegExp(`\\bif\\s+${sizeClassPattern(m)}\\s*[!=]=\\s*\\.\\w+\\s*$`);
    for (const b of blocks) {
      const sibling = b.parent?.children[b.parent.children.indexOf(b) + 1];
      const cond = matchBefore(m, b.open, sizeCheck);
      if (cond === null || !sibling || headerOf(src, sibling) !== 'else') continue;
      // Swapping Text and Image loses nothing; only views that hold state of their own lose it.
      const branches = m.slice(b.open, b.close) + m.slice(sibling.open, sibling.close);
      if (keepsState(branches, facts.views, m)) report('state-reset', cond);
    }
    for (const hit of m.matchAll(/\.id\s*\(\s*UUID\s*\(\s*\)\s*\)/g)) {
      // A spinner or a label has nothing to lose; a fresh identity just restarts it.
      const root = chainRoot(src, hit.index!);
      if (root?.name && (root.body ? STATELESS.test(root.name) && !keepsState(m.slice(root.body.open, root.body.close), facts.views, m) : STATELESS.test(root.name) || facts.views.get(root.name) === false)) continue;
      report('state-reset', hit.index!, '.id(UUID()) gives the view a new identity on every update, so its state never survives a fold.');
    }

    // Portrait locks in code: `override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }`,
    // or the app delegate's `application(_:supportedInterfaceOrientationsFor:)` returning only portrait.
    for (const hit of m.matchAll(/\bsupportedInterfaceOrientations(For\b[^{]{0,300}|\s*:\s*UIInterfaceOrientationMask\s*)\{\s*(?:get\s*\{\s*)?(?:return\s+)?(?:UIInterfaceOrientationMask)?\.portrait\s*\}/g)) {
      report('portrait-only', hit.index!, `${hit[1].startsWith('For') ? 'The app delegate locks every screen' : 'This screen locks itself'} to portrait. The inner display ignores the lock, so the layout gets a landscape canvas anyway.`);
    }

    for (const hit of m.matchAll(/\bUIApplication\s*\.\s*shared\s*\.\s*(windows|keyWindow|connectedScenes\s*\.\s*first(?!\s*\??\s*\.\s*delegate)|delegate\s*\??\s*\.\s*window)\b/g)) {
      // In a single-scene app `connectedScenes.first(where: { $0.activationState == .foregroundActive })` picks
      // the scene in use; with multiple scenes, two can be in the foreground side by side. A UI-test hook never runs for users.
      // With one scene, `connectedScenes.first` is that scene.
      if (facts.singleScene && !facts.multipleScenes && hit[1].startsWith('connectedScenes')) continue;
      if ((!facts.multipleScenes && /activationState\s*==\s*\.foregroundActive/.test(m.slice(hit.index!, hit.index! + 200))) || /UITest|uiTest/.test(m.slice(Math.max(0, hit.index! - 300), hit.index))) continue;
      report('key-window', hit.index!);
    }
    // `connectedScenes.flatMap { ... }.first { $0.isKeyWindow }`, often split over lines.
    for (const hit of m.matchAll(/\bUIApplication\s*\.\s*shared\s*\.\s*connectedScenes\b(?!\s*\.\s*first\b)/g)) {
      const statement = /^[^;]*?(?=\n[ \t]*\n|;|$)/.exec(m.slice(hit.index!, hit.index! + 400))![0];
      // Applying something to every scene's windows (`.forEach`, `for scene in connectedScenes`, or a loop over the scenes just collected) assumes nothing about which is in front.
      const bound = /\b(?:let|var)\s+(\w+)\s*=\s*$/.exec(m.slice(Math.max(0, hit.index! - 60), hit.index))?.[1];
      if (/\.forEach\b/.test(statement) || /\bfor\s+\w+\s+in\s+$/.test(m.slice(Math.max(0, hit.index! - 40), hit.index)) || (bound && new RegExp(`\\bfor\\s+\\w+\\s+in\\s+${bound}\\b`).test(statement))) continue;
      if (/\.windows\b|isKeyWindow/.test(statement) && (facts.multipleScenes || !/activationState\s*==\s*\.foregroundActive/.test(statement))) report('key-window', hit.index!);
    }

    for (const b of blocks) {
      if (b.label !== 'NavigationView' || b.argument) continue;
      const at = labelOffset(src, b);
      const target = facts.deploymentTarget;
      const edits = [{ start: at, end: at + 'NavigationView'.length, text: 'NavigationStack' }];
      // `.navigationViewStyle(.stack)`, on the NavigationView or on its content, already behaves as one NavigationStack column.
      if (chainHas(m, b.close + 1, /^navigationViewStyle$/, /^\s*(?:\.stack\b|StackNavigationViewStyle\b)/) || /\.navigationViewStyle\s*\(\s*(?:\.stack\b|StackNavigationViewStyle\b)/.test(m.slice(b.open, b.close))) continue;
      const columns = chainHas(m, b.close + 1, /^navigationViewStyle$/, /^\s*(?:\.columns|DoubleColumn)/);
      if (columns || countStatements(m.slice(b.open + 1, b.close)) !== 1) report('navigation-view', at);
      else if (target !== null && target < 16) {
        report('navigation-view', at, `NavigationStack needs iOS 16 and this project deploys to iOS ${target}. Switch when you raise the deployment target.`);
      } else {
        report(
          'navigation-view',
          at,
          undefined,
          target === null
            ? { confidence: 'review', description: 'Replace with NavigationStack. Needs iOS 16 or later; no Xcode project was given to check.', edits }
            : facts.otherPlatforms
              ? { confidence: 'review', description: 'Replace with NavigationStack. This project also builds for another platform; check this file’s targets (watchOS 9, macOS 13).', edits }
              : { confidence: 'safe', description: 'Replace with NavigationStack.', edits },
        );
      }
    }
  },

  objc({ masked: m, report }) {
    for (const hit of m.matchAll(/\[\s*UIScreen\s+mainScreen\s*\]|\bUIScreen\s*\.\s*mainScreen\b/g)) report('uiscreen-main', hit.index!, '[UIScreen mainScreen] is ambiguous on a two-display phone.');
    for (const hit of m.matchAll(/\bsharedApplication\s*\]?\s*(?:\.\s*|\s+)(?:keyWindow|windows|delegate\s*\]?\s*(?:\.\s*|\s+)window)\b/g)) report('key-window', hit.index!);
    const camera = CAMERA_FILE.test(m);
    for (const hit of m.matchAll(/\bstatusBarOrientation\b|\[\s*\[\s*UIDevice\s+currentDevice\s*\]\s+orientation\s*\]|\bUIDevice\s*\.\s*currentDevice\s*\.\s*orientation\b|\bUI(?:Interface|Device)OrientationIs(?:Landscape|Portrait)\b|\binterfaceOrientation\b/g)) {
      if (!camera && !NOT_LAYOUT.test(lineAround(m, hit.index!))) report('orientation-layout', hit.index!);
    }
    for (const hit of m.matchAll(/\bsupportedInterfaceOrientations(?:ForWindow\s*:[^{]{0,300})?\s*\{\s*return\s+\(?\s*UIInterfaceOrientationMaskPortrait\s*\)?\s*;\s*\}/g)) {
      report('portrait-only', hit.index!, 'This code locks to portrait. The inner display ignores the lock, so the layout gets a landscape canvas anyway.');
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
    for (const settings of iPhoneBuildSettings(file.content)) {
      const keys = [...settings.text.matchAll(/INFOPLIST_KEY_UISupportedInterfaceOrientations(_iPhone)?\s*=\s*"?([^";]*)"?;/g)];
      // The _iPhone key overrides the generic one, as `~iphone` does in Info.plist.
      const chosen = keys.some((k) => k[1]) ? keys.filter((k) => k[1]) : keys;
      for (const hit of chosen) {
        const value = hit[2].trim();
        if (!value || seen.has(value) || !isPortraitOnly(value.split(/\s+/))) continue;
        seen.add(value);
        report('portrait-only', settings.offset + hit.index!);
      }
    }
  },

  project({ facts, reporterFor }) {
    const usesScenes = facts.swiftUIApp || (facts.sceneManifest && facts.sceneDelegate);
    if (!usesScenes && facts.appDelegate) reporterFor(facts.appDelegate.file)('no-scene-lifecycle', facts.appDelegate.offset);
  },
});
