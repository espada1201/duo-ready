// What reviewers saw on iPhone Duo, traced to the root cause and the checks that catch it.

export interface PainPoint {
  id: string;
  title: string;
  /** What reviewers reported. */
  seen: string;
  /** Why it happens, from first principles. */
  cause: string;
  rules: string[];
}

export const PAIN_POINTS: PainPoint[] = [
  {
    id: 'black-bars',
    title: 'Black bars',
    seen: 'MKBHD and others found apps sitting in a window with black bars around it on the inner display.',
    cause: 'iOS keeps old apps in an iPhone-sized window until they are rebuilt with the iOS 27.1 SDK, and apps that hard-code iPhone sizes stay narrow even after a rebuild.',
    rules: ['old-sdk', 'requires-full-screen', 'fixed-device-size', 'centered-column'],
  },
  {
    id: 'misplaced',
    title: 'Misplaced buttons and bars',
    seen: 'Buttons and bars in the wrong place, colliding with the status bar or sitting where a thumb can’t reach.',
    cause: 'Duo moves the status bar to the side and turns system bars vertical. Only system-owned bars follow; hand-made bars and symmetric inset math don’t know the edges changed.',
    rules: ['hand-built-bar', 'symmetric-safe-area', 'tab-sidebar', 'edge-gesture'],
  },
  {
    id: 'stretched',
    title: 'Small or stretched elements',
    seen: 'Elements that look small or stretched on the big screen, in apps like Spotify, Google Maps and Discord.',
    cause: 'Layouts that pick a design from the device type, fixed font sizes and images without an aspect ratio all assume the screen shapes of past iPhones.',
    rules: ['idiom-layout', 'fixed-font', 'stretched-image'],
  },
  {
    id: 'fold',
    title: 'Breaks when you fold or unfold',
    seen: 'Reviewers praise how Apple’s own apps carry on mid-task when you open or close the phone. Third-party apps only do the same if they are built for it.',
    cause: 'A fold is a live resize across two displays. Apps that read “the” screen or window, decide layout from orientation, or rebuild views on size class lose their place.',
    rules: ['state-reset', 'uiscreen-main', 'key-window', 'orientation-layout', 'portrait-only', 'no-scene-lifecycle', 'navigation-view'],
  },
  {
    id: 'hinge',
    title: 'Ignores the hinge',
    seen: 'Half-folded is the pose reviewers liked for video and the split keyboard, but content that ignores the fold gets cut in two.',
    cause: 'The hinge is a reserved region that only exists when the phone is folded. Layouts that never ask about it put content under it.',
    rules: ['hinge-media', 'manual-two-pane', 'arrangement-in-scroll', 'navigation-in-arrangement', 'cross-platform'],
  },
  {
    id: 'hardware',
    title: 'Assumes iPhone hardware',
    seen: 'Reviewers flagged weaker cameras and no Face ID.',
    cause: 'Apps written for one hardware lineup hard-code Face ID copy and flows, or force-unwrap cameras that this phone doesn’t have.',
    rules: ['biometry-faceid', 'camera-hardware'],
  },
];
