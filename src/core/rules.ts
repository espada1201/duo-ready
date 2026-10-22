import { parsePlist, type PlistValue } from './plist';
import { ancestors, blockAt, declaredTypes, headerOf, lineStarts, parseSwift, position, walk, type Block, type SwiftSource } from './swift';
import type { Finding, Fix, Severity, SourceFile } from './types';

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  /** Why it matters on iPhone Duo, in one or two sentences. */
  why: string;
  /** What Apple says to do instead. */
  instead: string;
  /** Apple session or document the guidance comes from. */
  source: string;
}

const PREPARE = 'Apple Tech Talk “Prepare your app for iPhone Duo”';
const POSE = 'Apple Tech Talk “Strike a pose with adaptive layouts on iPhone Duo”';
const SCENES = 'Apple, WWDC25 “Make your UIKit app more flexible” (UIScene required after iOS 26)';

export const RULES: Rule[] = [
  {
    id: 'uiscreen-main',
    title: 'UIScreen.main on a two-display phone',
    severity: 'error',
    why: 'iPhone Duo has two displays, so “the main screen” is ambiguous. UIScreen.main is deprecated, and Apple says to remove it.',
    instead: 'Read scale from traitCollection.displayScale and sizes from your view or window scene.',
    source: PREPARE,
  },
  {
    id: 'idiom-layout',
    title: 'Layout decided by device idiom',
    severity: 'warning',
    why: 'Duo is a phone idiom with an iPad-sized inner display. Idiom checks pick the phone layout on a tablet-sized canvas.',
    instead: 'Switch layouts on horizontalSizeClass / verticalSizeClass.',
    source: PREPARE,
  },
  {
    id: 'orientation-layout',
    title: 'Layout decided by orientation',
    severity: 'warning',
    why: 'The inner display does not honor supported interface orientations, so orientation no longer predicts the canvas shape.',
    instead: 'Use size classes and the container’s own size.',
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
    id: 'fixed-device-size',
    title: 'Hard-coded iPhone screen size',
    severity: 'warning',
    why: 'Fixed iPhone widths and heights cause the stretched or tiny layouts reviewers saw. Duo windows resize live as the phone opens and closes.',
    instead: 'Size views relative to their container with stacks, flexible frames or Auto Layout.',
    source: PREPARE,
  },
  {
    id: 'hand-built-bar',
    title: 'Hand-built tab bar, toolbar or navigation bar',
    severity: 'warning',
    why: 'Only bars owned by system containers move to Duo’s vertical layout. Custom bars stay put and collide with the status bar and camera.',
    instead: 'Use TabView / NavigationStack toolbars, or place custom bars with the reserved regions API.',
    source: PREPARE,
  },
  {
    id: 'navigation-view',
    title: 'Deprecated NavigationView',
    severity: 'info',
    why: 'NavigationStack and NavigationSplitView are the containers Apple adapts to the fold: columns collapse when closed and tile when open.',
    instead: 'Use NavigationStack for one column, NavigationSplitView for list and detail.',
    source: PREPARE,
  },
  {
    id: 'arrangement-in-scroll',
    title: 'ArrangementView inside a scrolling container',
    severity: 'error',
    why: 'An arrangement sizes itself to its bounds; inside List or ScrollView it has no stable bounds to split.',
    instead: 'Put the ArrangementView outside the List / ScrollView and scroll inside each pane.',
    source: POSE,
  },
  {
    id: 'navigation-in-arrangement',
    title: 'NavigationSplitView inside ArrangementView',
    severity: 'error',
    why: 'ArrangementView provides no navigation infrastructure, and a split view inside it fights it for the same space.',
    instead: 'Put the ArrangementView inside your navigation container, not the other way round.',
    source: POSE,
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
    id: 'centered-column',
    title: 'Centered fixed-width column',
    severity: 'info',
    why: 'A narrow centered column leaves both sides of the inner display empty, and the hinge runs through its middle when folded.',
    instead: 'Audit centered layouts: consider a two-column ArrangementView, or displace content around the hinge.',
    source: POSE,
  },
  {
    id: 'manual-two-pane',
    title: 'Hand-rolled two-pane layout',
    severity: 'info',
    why: 'Switching to an HStack on regular width ignores the hinge and the aspect ratio. ArrangementView handles both.',
    instead: 'Use ArrangementView { primary } secondary: { secondary } with the .split style.',
    source: POSE,
  },
  {
    id: 'portrait-only',
    title: 'Portrait-only app',
    severity: 'warning',
    why: 'The inner display ignores your orientation lock, so a portrait-only layout gets a landscape canvas anyway.',
    instead: 'Support landscape on iPhone.',
    source: PREPARE,
  },
  {
    id: 'requires-full-screen',
    title: 'UIRequiresFullScreen is set',
    severity: 'info',
    why: 'Apple still honors it, but your app is resized anyway every time the phone opens or closes.',
    instead: 'Drop it once the app handles live resizing.',
    source: PREPARE,
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
    id: 'old-sdk',
    title: 'Project last upgraded before Xcode 27.1',
    severity: 'warning',
    why: 'Apps built with the iOS 26 SDK open in a centered iPhone-sized window; the iOS 27 SDK fills most of the inner display; only the iOS 27.1 SDK goes edge to edge.',
    instead: 'Build with Xcode 27.1 and test every pose in the iPhone Duo simulator.',
    source: PREPARE,
  },
  {
    id: 'cross-platform',
    title: 'Cross-platform framework detected',
    severity: 'info',
    why: 'React Native and Flutter layouts adapt, but neither framework exposes Duo reserved regions or arrangements yet.',
    instead: 'Bridge reservedRegions(kind:) and ArrangementView through a native module or platform channel.',
    source: PREPARE,
  },
  {
    id: 'state-reset',
    title: 'State resets when the phone opens or closes',
    severity: 'warning',
    why: 'Opening or closing Duo changes the size class mid-task. Views swapped on size class, or given a fresh .id, are rebuilt and lose their @State: scroll position, typed text, playback.',
    instead: 'Keep one view and change only its layout with AnyLayout or ViewThatFits; keep what matters in @SceneStorage.',
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
    id: 'fixed-font',
    title: 'Fixed font size',
    severity: 'info',
    why: 'Fixed point sizes ignore Dynamic Type, so text that suits a 6-inch phone looks small on the 7.6-inch inner display.',
    instead: 'Use text styles (.body, .headline), Font.custom(_:size:relativeTo:) or UIFontMetrics.',
    source: 'Apple Human Interface Guidelines, Typography',
  },
  {
    id: 'stretched-image',
    title: 'Image can stretch',
    severity: 'warning',
    why: 'A resizable image with no aspect ratio fills whatever frame it gets. On Duo’s new window shapes that means the stretched artwork reviewers saw.',
    instead: 'Add .scaledToFit() or .scaledToFill(), or use contentMode .scaleAspectFit.',
    source: 'Apple Human Interface Guidelines, Images',
  },
  {
    id: 'biometry-faceid',
    title: 'Assumes Face ID',
    severity: 'warning',
    why: 'iPhone Duo has no Face ID. Unlock flows and copy written for Face ID hide the option or tell people to use hardware they don’t have.',
    instead: 'Switch on LABiometryType and handle .touchID, and word prompts generically (“Unlock with biometrics”, or the type’s name at runtime).',
    source: 'Apple LocalAuthentication documentation (LABiometryType)',
  },
  {
    id: 'camera-hardware',
    title: 'Assumes a specific camera',
    severity: 'warning',
    why: 'Duo’s cameras differ from the Pro iPhones, and with no Face ID there is no TrueDepth camera. Force-unwrapping a lens that isn’t there crashes.',
    instead: 'Find cameras with AVCaptureDevice.DiscoverySession, fall back gracefully, and never force-unwrap a device.',
    source: 'Apple AVFoundation documentation (Choosing a capture device)',
  },
  {
    id: 'hinge-media',
    title: 'Full-screen media ignores the hinge',
    severity: 'info',
    why: 'Half-folded, the hinge runs through a full-screen video or camera preview. Apple’s guidance for tabletop use is viewing content on top and controls on the bottom.',
    instead: 'Read reservedRegions(kind: .division) and place the video in one region and controls in the other.',
    source: POSE,
  },
  {
    id: 'edge-gesture',
    title: 'Screen-edge swipe',
    severity: 'info',
    why: 'On the inner display the trailing edge holds the status bar and vertical system bars, and the fold adds a new edge in the middle. Edge swipes there fight the system.',
    instead: 'Prefer standard navigation gestures; if you need an edge pan, test it in every pose.',
    source: PREPARE,
  },
];

export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

type Report = (ruleId: string, offset: number, message?: string, fix?: Fix) => void;

function reporter(file: SourceFile, findings: Finding[], starts = lineStarts(file.content)): Report {
  return (ruleId, offset, message, fix) => {
    const rule = RULE_BY_ID.get(ruleId)!;
    const { line, column } = position({ lineStarts: starts }, offset);
    const end = file.content.indexOf('\n', starts[line - 1]);
    findings.push({
      ruleId,
      severity: rule.severity,
      path: file.path,
      line,
      column,
      message: message ?? rule.why,
      excerpt: file.content.slice(starts[line - 1], end === -1 ? undefined : end).trim(),
      fix,
    });
  };
}

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
  const header = headerOf(src, b);
  if (!/^(@\w+\s+)*((public|private|fileprivate|internal|open|final|override|@objc|mutating|nonisolated)\s+)*func\s/.test(header)) return null;
  const owner = declaredTypes(src).find((t) => t.block === b!.parent);
  const base = owner?.inherits[0] ?? '';
  if (UIKIT_CONTROLLERS.test(base)) return 'controller';
  if (UIKIT_VIEWS.test(base)) return 'view';
  return null;
}

// iPhone point sizes from the iPhone SE through the 17 Pro Max.
const PHONE_WIDTHS = new Set([320, 375, 390, 393, 402, 414, 428, 430, 440]);
const PHONE_HEIGHTS = new Set([568, 667, 736, 812, 844, 852, 874, 896, 926, 932, 956]);

const SCROLLERS = new Set(['List', 'ScrollView', 'LazyVStack', 'LazyHStack', 'Form']);
/** Closures whose content is presented elsewhere, so it is not laid out inside the enclosing scroller. */
const PRESENTED = new Set(['NavigationLink', 'sheet', 'fullScreenCover', 'popover', 'navigationDestination', 'inspector']);

function checkSwift(file: SourceFile, findings: Finding[]) {
  const src = parseSwift(file.content);
  const report = reporter(file, findings, src.lineStarts);
  const m = src.masked;

  for (const hit of m.matchAll(/\bUIScreen\s*\.\s*main\b(\s*\.\s*(scale|bounds|nativeScale)\b)?/g)) {
    const ctx = uikitContext(src, hit.index!);
    const member = hit[2];
    let fix: Fix | undefined;
    const span = { start: hit.index!, end: hit.index! + hit[0].length };
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

  for (const hit of m.matchAll(/\buserInterfaceIdiom\b/g)) report('idiom-layout', hit.index!);

  for (const hit of m.matchAll(/\bUIDevice\s*\.\s*current\s*\.\s*orientation(?:\s*\.\s*is(?:Landscape|Portrait))?\b|\binterfaceOrientation\b|\bstatusBarOrientation\b|\.isLandscape\b|\.isPortrait\b/g)) {
    report('orientation-layout', hit.index!);
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

  for (const hit of m.matchAll(/\b(width|height|maxWidth|maxHeight|minWidth|minHeight)\s*(?::|==|<=|>=|<|>)\s*(\d{3})(?:\.0)?\b/g)) {
    const n = Number(hit[2]);
    const isWidth = /width/i.test(hit[1]);
    if ((isWidth && PHONE_WIDTHS.has(n)) || (!isWidth && PHONE_HEIGHTS.has(n))) {
      report('fixed-device-size', hit.index!, `${n} pt is an iPhone ${isWidth ? 'screen width' : 'screen height'}; Duo windows are other sizes and change live.`);
    }
  }

  for (const hit of m.matchAll(/\b(UITabBar|UIToolbar|UINavigationBar)\s*\(/g)) {
    report('hand-built-bar', hit.index!, `${hit[1]} created by hand won’t get Duo’s vertical bar layout.`);
  }
  for (const hit of m.matchAll(/\bstruct\s+(\w*(?:TabBar|Toolbar|NavBar|NavigationBar|BottomBar)\w*)\s*:\s*[^{]*\bView\b/g)) {
    report('hand-built-bar', hit.index!, `${hit[1]} is a custom bar; it will stay horizontal while system bars go vertical.`);
  }

  const blocks = [...walk(src.root)];
  for (const b of blocks) {
    if (b.label === 'NavigationView' && !b.argument) {
      const at = m.lastIndexOf('NavigationView', b.open);
      report(
        'navigation-view',
        at,
        undefined,
        countStatements(m.slice(b.open + 1, b.close)) === 1
          ? { confidence: 'safe', description: 'Replace with NavigationStack.', edits: [{ start: at, end: at + 'NavigationView'.length, text: 'NavigationStack' }] }
          : undefined,
      );
    }
    if (b.label === 'ArrangementView' && !b.argument) {
      let scroller: Block | undefined;
      for (const a of ancestors(b)) {
        if (a.label && PRESENTED.has(a.label)) break;
        if (a.label && SCROLLERS.has(a.label)) {
          scroller = a;
          break;
        }
      }
      if (scroller) report('arrangement-in-scroll', m.lastIndexOf('ArrangementView', b.open), `ArrangementView is inside ${scroller.label}.`);
    }
    if (b.label === 'NavigationSplitView' && !b.argument && ancestors(b).some((a) => a.label === 'ArrangementView')) {
      report('navigation-in-arrangement', m.lastIndexOf(b.label, b.open), 'NavigationSplitView is inside an ArrangementView.');
    }
    const modifiers = b.label === 'TabView' && !b.argument ? m.slice(b.close + 1, afterModifiers(m, b.close + 1)) : null;
    if (modifiers !== null && !/\.defaultTabBarPlacement\b|\.sidebarAdaptable\b/.test(modifiers)) {
      const indent = lineIndent(file.content, b.open);
      const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
      report('tab-sidebar', m.lastIndexOf('TabView', b.open), undefined, {
        confidence: 'review',
        description: 'Show tabs as a sidebar on the inner display. Needs the iOS 27.1 SDK.',
        edits: [{ start: b.close + 1, end: b.close + 1, text: `${eol}${indent}.defaultTabBarPlacement(.sidebar)` }],
      });
    }
    // `if horizontalSizeClass == .regular { HStack { … } }`
    const head = m.slice(Math.max(0, b.open - 80), b.open);
    const sizeCheck = /\b\w*[sS]izeClass\w*\s*==\s*\.regular\s*$/.exec(head);
    if (sizeCheck && b.children.some((c) => c.label === 'HStack')) report('manual-two-pane', b.open - head.length + sizeCheck.index);
  }

  for (const hit of m.matchAll(/\.frame\s*\(\s*maxWidth\s*:\s*(\d{3})(?:\.0)?\s*[,)]/g)) {
    const n = Number(hit[1]);
    if (n >= 320 && n <= 720) report('centered-column', hit.index!, `A ${n} pt column fills about ${Math.round((n / 890) * 100)}% of the open inner display.`);
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

  for (const hit of m.matchAll(/\.system\s*\(\s*size\s*:|\bUIFont\s*\.\s*(?:systemFont|boldSystemFont|italicSystemFont|monospacedSystemFont)\s*\(\s*ofSize\s*:|\bUIFont\s*\(\s*name\s*:[^)]*size\s*:|\.custom\s*\([^)]*size\s*:/g)) {
    const line = lineAround(m, hit.index!);
    if (/relativeTo\s*:|UIFontMetrics|scaledFont/.test(line)) continue;
    report('fixed-font', hit.index!);
  }

  for (const hit of m.matchAll(/\.resizable\s*\(\s*\)/g)) {
    const end = hit.index! + hit[0].length;
    const chain = m.slice(end, afterModifiers(m, end));
    if (/\.(aspectRatio|scaledToFit|scaledToFill)\b/.test(chain)) continue;
    const indent = /\n([ \t]*)\.resizable/.exec(file.content.slice(Math.max(0, hit.index! - 200), end));
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    report('stretched-image', hit.index!, undefined, {
      confidence: 'review',
      description: 'Keep the image’s aspect ratio.',
      edits: [{ start: end, end, text: indent ? `${eol}${indent[1]}.scaledToFit()` : '.scaledToFit()' }],
    });
  }
  for (const hit of m.matchAll(/\.contentMode\s*=\s*\.scaleToFill\b/g)) report('stretched-image', hit.index!);

  const handlesTouchID = /\.touchID\b/.test(m);
  if (!handlesTouchID) {
    for (const hit of m.matchAll(/\.faceID\b/g)) report('biometry-faceid', hit.index!);
  }
  // Copy lives in strings, which the mask blanks: look at the raw text where the mask is blank.
  for (const hit of file.content.matchAll(/Face ID/g)) {
    const i = hit.index!;
    if (m.slice(i, i + 7) === '       ' && !isComment(file.content, i)) report('biometry-faceid', i, 'User-facing text mentions Face ID, which iPhone Duo doesn’t have.');
  }

  for (const hit of m.matchAll(/\bAVCaptureDevice\s*\.\s*default\s*\((?:[^()]|\([^()]*\))*\)\s*!/g)) {
    report('camera-hardware', hit.index!, 'Force-unwrapping a capture device crashes when that camera isn’t there.');
  }
  for (const hit of m.matchAll(/\.builtInTrueDepthCamera\b/g)) {
    if (!/\bAVCaptureDevice\s*\.\s*default\s*\((?:[^()]|\([^()]*\))*\)\s*!/.test(lineAround(m, hit.index!))) {
      report('camera-hardware', hit.index!, 'The TrueDepth camera comes with Face ID; iPhone Duo has neither.');
    }
  }

  if (!/\breservedRegions\b|\bArrangementView\b/.test(m)) {
    for (const hit of m.matchAll(/\b(VideoPlayer|AVPlayerLayer|AVCaptureVideoPreviewLayer)\s*\(/g)) report('hinge-media', hit.index!);
  }

  for (const hit of m.matchAll(/\bUIScreenEdgePanGestureRecognizer\s*\(/g)) report('edge-gesture', hit.index!);
}

function lineAround(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? undefined : end);
}

/** True when `offset` is inside a // or /* comment rather than a string literal. */
function isComment(text: string, offset: number): boolean {
  const line = lineAround(text, offset);
  const col = offset - (text.lastIndexOf('\n', offset) + 1);
  const slashes = line.indexOf('//');
  if (slashes !== -1 && slashes < col && !line.slice(0, slashes).includes('"')) return true;
  const open = text.lastIndexOf('/*', offset);
  return open !== -1 && text.lastIndexOf('*/', offset) < open;
}

/** End offset of a chain of `.modifier(...)` calls following a closing brace. */
function afterModifiers(masked: string, from: number): number {
  const re = /^\s*\.\w+\s*(\((?:[^()]|\([^()]*\))*\))?/;
  let at = from;
  for (;;) {
    const hit = re.exec(masked.slice(at));
    if (!hit) return at;
    at += hit[0].length;
  }
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
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

function plistFindings(file: SourceFile, findings: Finding[]) {
  const parsed = parsePlist(file.content);
  if (!parsed) return;
  const report = reporter(file, findings);
  const { keys } = parsed;
  const orientations = keys.get('UISupportedInterfaceOrientations~iphone') ?? keys.get('UISupportedInterfaceOrientations');
  if (orientations && Array.isArray(orientations.value) && orientations.value.length > 0) {
    if (orientations.value.every((v: PlistValue) => typeof v === 'string' && v.includes('Portrait'))) report('portrait-only', orientations.offset);
  }
  const full = keys.get('UIRequiresFullScreen');
  if (full && full.value === true) report('requires-full-screen', full.offset);
}

interface ProjectFacts {
  hasSceneManifest: boolean;
  hasSwiftUIApp: boolean;
  hasSceneDelegate: boolean;
  appDelegateOffset: { file: SourceFile; offset: number } | null;
}

export function checkFiles(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const facts: ProjectFacts = { hasSceneManifest: false, hasSwiftUIApp: false, hasSceneDelegate: false, appDelegateOffset: null };

  for (const file of files) {
    const name = file.path.split('/').pop()!;
    if (name.endsWith('.swift')) {
      checkSwift(file, findings);
      const masked = parseSwift(file.content).masked;
      if (/@main\s+struct\s+\w+\s*:\s*[^{]*\bApp\b/.test(masked)) facts.hasSwiftUIApp = true;
      if (/\bUIWindowSceneDelegate\b/.test(masked)) facts.hasSceneDelegate = true;
      const appDelegate = /\bclass\s+\w+\s*:\s*[^{]*\bUIApplicationDelegate\b/.exec(masked);
      if (appDelegate && !facts.appDelegateOffset) facts.appDelegateOffset = { file, offset: appDelegate.index };
    } else if (name.endsWith('.plist')) {
      plistFindings(file, findings);
      if (parsePlist(file.content)?.keys.has('UIApplicationSceneManifest')) facts.hasSceneManifest = true;
    } else if (name === 'project.pbxproj') {
      if (/INFOPLIST_KEY_UIApplicationSceneManifest_Generation\s*=\s*YES/.test(file.content)) facts.hasSceneManifest = true;
      pbxprojFindings(file, findings);
    } else if (name === 'package.json' && /"react-native"\s*:/.test(file.content)) {
      reporter(file, findings)('cross-platform', file.content.indexOf('"react-native"'), 'React Native app: layouts adapt, but Duo reserved regions and arrangements need a native module.');
    } else if (name === 'pubspec.yaml' && /^\s*flutter\s*:/m.test(file.content)) {
      reporter(file, findings)('cross-platform', file.content.search(/^\s*flutter\s*:/m), 'Flutter app: layouts adapt, but Duo reserved regions and arrangements need a platform channel.');
    }
  }

  const usesScenes = facts.hasSwiftUIApp || (facts.hasSceneManifest && facts.hasSceneDelegate);
  if (!usesScenes && facts.appDelegateOffset) {
    reporter(facts.appDelegateOffset.file, findings)('no-scene-lifecycle', facts.appDelegateOffset.offset);
  }
  return findings;
}

function pbxprojFindings(file: SourceFile, findings: Finding[]) {
  const report = reporter(file, findings);
  const seen = new Set<string>();
  for (const hit of file.content.matchAll(/INFOPLIST_KEY_UISupportedInterfaceOrientations(?:_iPhone)?\s*=\s*"?([^";]*)"?;/g)) {
    const value = hit[1].trim();
    if (!value || seen.has(value) || !value.split(/\s+/).every((o) => o.includes('Portrait'))) continue;
    seen.add(value);
    report('portrait-only', hit.index!);
  }
  const full = /INFOPLIST_KEY_UIRequiresFullScreen\s*=\s*YES;/.exec(file.content);
  if (full) report('requires-full-screen', full.index);
  const upgrade = /LastUpgradeCheck\s*=\s*(\d{4});/.exec(file.content);
  if (upgrade && Number(upgrade[1]) < 2710) {
    report('old-sdk', upgrade.index, `Last upgraded with Xcode ${xcodeVersion(upgrade[1])}; Duo users likely see ${tierLabel(tierFromUpgradeCheck(upgrade[1]))}.`);
  }
}

export function xcodeVersion(check: string): string {
  const major = Number(check.slice(0, 2));
  const minor = Number(check[2]);
  return `${major}.${minor}`;
}

export function tierFromUpgradeCheck(check: string): '26' | '27' | '27.1' {
  const n = Number(check);
  if (n >= 2710) return '27.1';
  if (n >= 2700) return '27';
  return '26';
}

export function tierLabel(tier: '26' | '27' | '27.1'): string {
  return tier === '26' ? 'a centered iPhone-sized window' : tier === '27' ? 'an almost-full inner display' : 'the full edge-to-edge layout';
}
