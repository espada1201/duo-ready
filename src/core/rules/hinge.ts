import { ancestors, labelOffset, type Block } from '../swift';
import { defineGroup, matchBefore, POSE, PREPARE, sizeClassPattern } from './engine';

const SCROLLERS = new Set(['List', 'ScrollView', 'LazyVStack', 'LazyHStack', 'Form']);
/** Closures whose content is presented elsewhere, so it is not laid out inside the enclosing scroller. */
const PRESENTED = new Set(['NavigationLink', 'sheet', 'fullScreenCover', 'popover', 'navigationDestination', 'inspector']);

export const hinge = defineGroup({
  id: 'hinge',
  title: 'Ignores the hinge',
  seen: 'Half-folded is the pose reviewers liked for video and the split keyboard, but content that ignores the fold gets cut in two.',
  cause: 'The hinge is a reserved region that only exists when the phone is folded. Layouts and keyboard math that never ask about it put content under it.',
  rules: [
    {
      id: 'hinge-media',
      title: 'Full-screen media ignores the hinge',
      severity: 'info',
      why: 'Half-folded, the hinge runs through a full-screen video or camera preview. Apple’s guidance for tabletop use is viewing content on top and controls on the bottom.',
      instead: 'Read reservedRegions(kind: .division) and place the video in one region and controls in the other.',
      source: POSE,
    },
    {
      id: 'keyboard-frame',
      title: 'Keyboard math assumes one full-width keyboard',
      severity: 'warning',
      why: 'Half-folded, Duo’s keyboard splits around the hinge. Code that subtracts the keyboard frame from the screen assumes one keyboard docked full width at the bottom, so text fields end up hidden or pushed too far.',
      instead: 'Pin content to view.keyboardLayoutGuide (iOS 15+), which follows docked, split and floating keyboards. In SwiftUI, let the keyboard safe area do it.',
      source: 'Apple, WWDC21 “Your guide to keyboard layout” (UIKeyboardLayoutGuide)',
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
      id: 'cross-platform',
      title: 'Cross-platform framework detected',
      severity: 'info',
      why: 'React Native and Flutter layouts resize, but neither framework reports Duo’s hinge or reserved regions yet.',
      instead: 'Bridge reservedRegions(kind:) and ArrangementView through a native module or platform channel.',
      source: PREPARE,
    },
  ],

  swift({ src, masked: m, blocks, facts, report }) {
    if (!/\breservedRegions\b|\bArrangementView\b/.test(m)) {
      // SwiftUI's VideoPlayer comes from AVKit; where the app declares its own, only files importing AVKit mean Apple's.
      const avkit = !facts.ownVideoPlayer || /\bimport\s+(?:AVKit|_AVKit_SwiftUI)\b/.test(m);
      for (const hit of m.matchAll(/\b(VideoPlayer|AVPlayerLayer|AVCaptureVideoPreviewLayer)\s*\(/g)) if (hit[1] !== 'VideoPlayer' || avkit) report('hinge-media', hit.index!);
    }

    if (!/\bkeyboardLayoutGuide\b/.test(m)) {
      for (const hit of m.matchAll(/\b(?:UIResponder\s*\.\s*)?keyboardFrame(?:End|Begin)UserInfoKey\b|\bUIKeyboardFrame(?:End|Begin)UserInfoKey\b/g)) {
        report('keyboard-frame', hit.index!);
      }
    }

    // `if horizontalSizeClass == .regular { HStack { … } }`, or `!= .compact`.
    const regular = new RegExp(`\\b${sizeClassPattern(m)}\\s*(?:==\\s*\\.regular|!=\\s*\\.compact)\\s*$`);
    for (const b of blocks) {
      const sizeCheck = matchBefore(m, b.open, regular);
      if (sizeCheck !== null && b.children.some((c) => c.label === 'HStack')) report('manual-two-pane', sizeCheck);

      if (b.argument) continue;
      if (b.label === 'ArrangementView') {
        let scroller: Block | undefined;
        for (const a of ancestors(b)) {
          if (a.label && PRESENTED.has(a.label)) break;
          if (a.label && SCROLLERS.has(a.label)) {
            scroller = a;
            break;
          }
        }
        if (scroller) report('arrangement-in-scroll', labelOffset(src, b), `ArrangementView is inside ${scroller.label}.`);
      }
      if (b.label === 'NavigationSplitView' && ancestors(b).some((a) => a.label === 'ArrangementView')) {
        report('navigation-in-arrangement', labelOffset(src, b), 'NavigationSplitView is inside an ArrangementView.');
      }
    }
  },

  objc({ masked: m, report }) {
    if (!/\breservedRegions\b/.test(m)) {
      // `[AVPlayerLayer class]` is a type check, except where `+layerClass` makes the view a video surface.
      for (const hit of m.matchAll(/\[\s*(?:AVPlayerLayer|AVCaptureVideoPreviewLayer)\s+(\w+)/g)) {
        if (hit[1] !== 'class' || /\(\s*Class\s*\)\s*layerClass\s*\{[^{}]*$/.test(m.slice(Math.max(0, hit.index! - 120), hit.index))) report('hinge-media', hit.index!);
      }
    }
    if (!/\bkeyboardLayoutGuide\b/.test(m)) {
      for (const hit of m.matchAll(/\bUIKeyboardFrame(?:End|Begin)UserInfoKey\b/g)) report('keyboard-frame', hit.index!);
    }
  },

  manifest({ file, report }) {
    if (file.path.endsWith('package.json') && /"react-native"\s*:/.test(file.content)) {
      report(
        'cross-platform',
        file.content.indexOf('"react-native"'),
        'React Native app: Flexbox layouts resize, but nothing reports Duo’s hinge. Wrap reservedRegions(kind:) in a native module, and listen for Dimensions changes instead of reading the size once.',
      );
    } else if (file.path.endsWith('pubspec.yaml') && /^\s*flutter\s*:/m.test(file.content) && !/^\s+plugin\s*:/m.test(file.content)) {
      report(
        'cross-platform',
        file.content.search(/^\s*flutter\s*:/m),
        'Flutter app: MediaQuery.displayFeaturesOf(context) is where Flutter reports hinges, but on iOS it is empty. Pass reservedRegions(kind:) through a platform channel, and size from MediaQuery.sizeOf rather than fixed widths.',
      );
    }
  },
});
