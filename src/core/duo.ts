// A model of how iPhone Duo presents an app, built from Apple's published specs
// (apple.com/iphone-duo/specs) and the iPhone Duo tech talks. Panel sizes are the
// spec pixels at 3x. Status bar, hinge and camera geometry are approximations:
// confirm them in the Xcode 27.1 iPhone Duo simulator.

import { area, clipTo, type Rect } from './rect';
import type { SdkTier } from './types';

interface Insets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type Posture = 'closed' | 'closed-landscape' | 'open' | 'open-portrait' | 'split' | 'book' | 'tent';
type SizeClass = 'compact' | 'regular';

interface ReservedRegion {
  kind: 'division' | 'occlusion';
  frame: Rect;
  active: boolean;
}

export interface Presentation {
  display: 'inner' | 'outer';
  screen: { w: number; h: number };
  window: Rect;
  sizeClass: { horizontal: SizeClass; vertical: SizeClass };
  safeArea: Insets;
  bars: 'horizontal' | 'vertical';
  /** Regions in window coordinates. Inactive regions are included, as with `.includeInactive`. */
  regions: ReservedRegion[];
  /** The system status bar in window coordinates, when it overlaps the window. */
  statusBar: Rect | null;
  /** Share of the display the system gives this app: half in Split View. */
  share: number;
  /** Share of that space the app can draw on. */
  coverage: number;
}

const SCALE = 3;
const INNER_PX = { w: 2670, h: 1878 };
const OUTER_PX = { w: 1398, h: 2034 };
export const INNER = { w: INNER_PX.w / SCALE, h: INNER_PX.h / SCALE };
export const OUTER = { w: OUTER_PX.w / SCALE, h: OUTER_PX.h / SCALE };

const STATUS_STRIP = 40;
const STATUS_STRIP_HEIGHT = 96;
const STATUS_TOP = 54;
const HOME_INDICATOR = 21;
const HINGE = 24;
const CAMERA = 36;

export const POSTURES: { id: Posture; label: string; detail: string }[] = [
  { id: 'closed', label: 'Closed', detail: 'Outer display, held upright' },
  { id: 'closed-landscape', label: 'Closed, sideways', detail: 'Outer display, landscape' },
  { id: 'open', label: 'Open', detail: 'Inner display, flat' },
  { id: 'open-portrait', label: 'Open, rotated', detail: 'Inner display turned upright' },
  { id: 'split', label: 'Split View', detail: 'Inner display shared 50/50 with another app' },
  { id: 'book', label: 'Book', detail: 'Half folded, hinge runs top to bottom' },
  { id: 'tent', label: 'Propped up', detail: 'Half folded on a table, hinge runs across' },
];

const ZERO: Insets = { top: 0, left: 0, bottom: 0, right: 0 };

function screenFor(posture: Posture): { display: 'inner' | 'outer'; w: number; h: number } {
  switch (posture) {
    case 'closed':
      return { display: 'outer', ...OUTER };
    case 'closed-landscape':
      return { display: 'outer', w: OUTER.h, h: OUTER.w };
    case 'open':
    case 'split':
    case 'book':
      return { display: 'inner', ...INNER };
    case 'open-portrait':
    case 'tent':
      return { display: 'inner', w: INNER.h, h: INNER.w };
  }
}

function screenRegions(posture: Posture, screen: { w: number; h: number }, cameraActive: boolean): ReservedRegion[] {
  const out: ReservedRegion[] = [];
  const display = screenFor(posture).display;
  if (display === 'inner') {
    const folded = posture === 'book' || posture === 'tent';
    // The fold runs along the long axis's midpoint. Inactive divisions have zero width.
    if (screen.w > screen.h) {
      out.push({ kind: 'division', active: folded, frame: { x: screen.w / 2 - (folded ? HINGE / 2 : 0), y: 0, w: folded ? HINGE : 0, h: screen.h } });
    } else {
      out.push({ kind: 'division', active: folded, frame: { x: 0, y: screen.h / 2 - (folded ? HINGE / 2 : 0), w: screen.w, h: folded ? HINGE : 0 } });
    }
    out.push({ kind: 'occlusion', active: cameraActive, frame: { x: screen.w - STATUS_STRIP / 2 - CAMERA / 2, y: 10, w: CAMERA, h: CAMERA } });
  }
  return out;
}

/** The system status bar in screen coordinates: a column on the right of the landscape inner display. */
export function statusBarRect(screen: { w: number; h: number }): Rect {
  return screen.w > screen.h
    ? { x: screen.w - STATUS_STRIP, y: 0, w: STATUS_STRIP, h: STATUS_STRIP_HEIGHT }
    : { x: 0, y: 0, w: screen.w, h: STATUS_TOP };
}

/**
 * What an app built with `tier`'s SDK gets in `posture`:
 * - iOS 26 SDK and earlier: an iPhone-sized, iPhone-shaped window centered on the inner display.
 * - iOS 27 SDK: extends to the edge but stops at the side status bar.
 * - iOS 27.1 SDK: edge to edge; system bars run vertically under the status bar.
 */
export function present(posture: Posture, tier: SdkTier, cameraActive = false): Presentation {
  const s = screenFor(posture);
  const screen = { w: s.w, h: s.h };
  const landscape = s.w > s.h;
  let window: Rect = { x: 0, y: 0, w: s.w, h: s.h };
  let safeArea: Insets = { ...ZERO };
  let bars: Presentation['bars'] = 'horizontal';
  // In Split View the app gets the leading half; the other app and the status bar take the rest.
  const share = posture === 'split' ? 0.5 : 1;
  const space = { w: s.w * share, h: s.h };

  if (s.display === 'inner' && tier === '26') {
    // A familiar iPhone: the outer display's shape, scaled to fit the space.
    const k = Math.min(1, space.h / OUTER.h, space.w / OUTER.w);
    const w = OUTER.w * k;
    const h = OUTER.h * k;
    window = { x: (space.w - w) / 2, y: (space.h - h) / 2, w, h };
    safeArea = { top: STATUS_TOP * k, left: 0, bottom: HOME_INDICATOR * k, right: 0 };
  } else if (share < 1) {
    window = { x: 0, y: 0, ...space };
    safeArea = { top: 0, left: 0, bottom: HOME_INDICATOR, right: 0 };
  } else if (landscape && tier !== '27.1') {
    window = { x: 0, y: 0, w: s.w - STATUS_STRIP, h: s.h };
    safeArea = { top: 0, left: 0, bottom: HOME_INDICATOR, right: 0 };
  } else if (landscape) {
    safeArea = { top: 0, left: 0, bottom: HOME_INDICATOR, right: STATUS_STRIP };
    bars = 'vertical';
  } else {
    safeArea = { top: STATUS_TOP, left: 0, bottom: HOME_INDICATOR, right: 0 };
  }

  const regions: ReservedRegion[] = [];
  for (const r of screenRegions(posture, screen, cameraActive)) {
    const clipped = clipTo(r.frame, window);
    if (clipped) regions.push({ ...r, frame: clipped });
  }

  const status = clipTo(statusBarRect(screen), window);
  const sizeClass = sizeClassFor(s.display, posture, window);
  return {
    display: s.display,
    screen,
    window,
    sizeClass,
    safeArea,
    bars,
    regions,
    statusBar: status && area(status) > 0 ? status : null,
    share,
    coverage: area(window) / area(space),
  };
}

/** The window's safe area, in window coordinates. */
export function safeFrame(p: Presentation): Rect {
  const sa = p.safeArea;
  return { x: sa.left, y: sa.top, w: p.window.w - sa.left - sa.right, h: p.window.h - sa.top - sa.bottom };
}

function sizeClassFor(display: 'inner' | 'outer', posture: Posture, window: Rect): Presentation['sizeClass'] {
  if (display === 'inner') {
    // A compatibility window reports what an iPhone would.
    return window.w < OUTER.w + 1 && window.h <= OUTER.h + 1 ? { horizontal: 'compact', vertical: 'regular' } : { horizontal: 'regular', vertical: 'regular' };
  }
  return posture === 'closed' ? { horizontal: 'compact', vertical: 'regular' } : { horizontal: 'compact', vertical: 'compact' };
}

type ArrangementStyle = 'split' | 'overlay';

export interface Arrangement {
  primary: Rect;
  secondary: Rect | null;
  /** Overlay arrangements stack the secondary view above the primary. */
  secondaryZIndex: number;
  axis: 'horizontal' | 'vertical' | null;
}

/** Minimum pane length along the split axis. A heuristic: Apple does not publish its threshold. */
export const MIN_PANE = 360;

/**
 * Duo Lab's reading of ArrangementView as described in Apple's tech talk: split along the
 * longer axis, at an active division if one crosses it; show only the primary view when
 * the split would make panes too small. Overlay stacks the secondary view over the
 * primary, and goes side by side when the device folds.
 */
export function arrange(
  bounds: { w: number; h: number },
  regions: ReservedRegion[],
  style: ArrangementStyle,
  axes: ('horizontal' | 'vertical')[] = ['horizontal', 'vertical'],
): Arrangement {
  const full: Rect = { x: 0, y: 0, w: bounds.w, h: bounds.h };
  const primaryOnly: Arrangement = { primary: full, secondary: null, secondaryZIndex: 0, axis: null };
  const division = regions.find((r) => r.kind === 'division' && r.active && area(r.frame) > 0);
  const divisionAxis = division ? (division.frame.h >= bounds.h - 0.5 ? 'horizontal' : 'vertical') : null;

  if (style === 'overlay' && !division) {
    const h = Math.round(bounds.h * 0.38);
    return { primary: full, secondary: { x: 0, y: bounds.h - h, w: bounds.w, h }, secondaryZIndex: 1, axis: null };
  }

  const axis = divisionAxis ?? (bounds.w > bounds.h ? 'horizontal' : 'vertical');
  if (!axes.includes(axis)) return primaryOnly;

  const length = axis === 'horizontal' ? bounds.w : bounds.h;
  let a: number;
  let b: number;
  if (division) {
    a = axis === 'horizontal' ? division.frame.x : division.frame.y;
    b = axis === 'horizontal' ? division.frame.x + division.frame.w : division.frame.y + division.frame.h;
  } else {
    a = b = length / 2;
  }
  if (a < MIN_PANE || length - b < MIN_PANE) return primaryOnly;

  const first: Rect = axis === 'horizontal' ? { x: 0, y: 0, w: a, h: bounds.h } : { x: 0, y: 0, w: bounds.w, h: a };
  const second: Rect = axis === 'horizontal' ? { x: b, y: 0, w: bounds.w - b, h: bounds.h } : { x: 0, y: b, w: bounds.w, h: bounds.h - b };
  return { primary: first, secondary: second, secondaryZIndex: 0, axis };
}
