// A model of how iPhone Duo presents an app, built from Apple's published specs
// (apple.com/iphone-duo/specs) and the iPhone Duo tech talks. Panel sizes are the
// spec pixels at 3x. Status bar, hinge and camera geometry are approximations:
// confirm them in the Xcode 27.1 iPhone Duo simulator.

import type { SdkTier } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type Posture = 'closed' | 'closed-landscape' | 'open' | 'open-portrait' | 'book' | 'tent';
export type SizeClass = 'compact' | 'regular';

export interface ReservedRegion {
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
  /** Share of the display the app can draw on. */
  coverage: number;
}

export const SCALE = 3;
export const INNER_PX = { w: 2670, h: 1878 };
export const OUTER_PX = { w: 1398, h: 2034 };
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
  { id: 'book', label: 'Book', detail: 'Half folded, hinge runs top to bottom' },
  { id: 'tent', label: 'Propped up', detail: 'Half folded on a table, hinge runs across' },
];

const ZERO: Insets = { top: 0, left: 0, bottom: 0, right: 0 };

export function screenFor(posture: Posture): { display: 'inner' | 'outer'; w: number; h: number } {
  switch (posture) {
    case 'closed':
      return { display: 'outer', ...OUTER };
    case 'closed-landscape':
      return { display: 'outer', w: OUTER.h, h: OUTER.w };
    case 'open':
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

function statusBarRect(screen: { w: number; h: number }): Rect {
  return screen.w > screen.h
    ? { x: screen.w - STATUS_STRIP, y: 0, w: STATUS_STRIP, h: STATUS_STRIP_HEIGHT }
    : { x: 0, y: 0, w: screen.w, h: STATUS_TOP };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r < x || bt < y) return null;
  return { x, y, w: r - x, h: bt - y };
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

  if (s.display === 'inner' && tier === '26') {
    // A familiar iPhone: the outer display's shape, scaled to fit the inner one.
    const k = Math.min(1, s.h / OUTER.h, s.w / OUTER.w);
    const w = OUTER.w * k;
    const h = OUTER.h * k;
    window = { x: (s.w - w) / 2, y: (s.h - h) / 2, w, h };
    safeArea = { top: STATUS_TOP * k, left: 0, bottom: HOME_INDICATOR * k, right: 0 };
  } else if (landscape && tier !== '27.1') {
    window = { x: 0, y: 0, w: s.w - STATUS_STRIP, h: s.h };
    safeArea = { top: 0, left: 0, bottom: HOME_INDICATOR, right: 0 };
  } else if (landscape) {
    safeArea = { top: 0, left: 0, bottom: HOME_INDICATOR, right: STATUS_STRIP };
    bars = 'vertical';
  } else {
    safeArea = { top: STATUS_TOP, left: 0, bottom: HOME_INDICATOR, right: 0 };
  }

  const toWindow = (r: Rect): Rect => ({ x: r.x - window.x, y: r.y - window.y, w: r.w, h: r.h });
  const regions: ReservedRegion[] = [];
  for (const r of screenRegions(posture, screen, cameraActive)) {
    const clipped = intersect(r.frame, window);
    if (!clipped) continue;
    regions.push({ ...r, frame: toWindow(clipped) });
  }

  const status = intersect(statusBarRect(screen), window);
  const sizeClass = sizeClassFor(s.display, posture, window);
  return {
    display: s.display,
    screen,
    window,
    sizeClass,
    safeArea,
    bars,
    regions,
    statusBar: status && status.w * status.h > 0 ? toWindow(status) : null,
    coverage: (window.w * window.h) / (s.w * s.h),
  };
}

function sizeClassFor(display: 'inner' | 'outer', posture: Posture, window: Rect): Presentation['sizeClass'] {
  if (display === 'inner') {
    // A compatibility window reports what an iPhone would.
    return window.w < OUTER.w + 1 && window.h <= OUTER.h + 1 ? { horizontal: 'compact', vertical: 'regular' } : { horizontal: 'regular', vertical: 'regular' };
  }
  return posture === 'closed' ? { horizontal: 'compact', vertical: 'regular' } : { horizontal: 'compact', vertical: 'compact' };
}

export type ArrangementStyle = 'split' | 'overlay';

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
  const division = regions.find((r) => r.kind === 'division' && r.active && r.frame.w * r.frame.h > 0);
  const divisionAxis = division ? (division.frame.h >= bounds.h - 0.5 ? 'horizontal' : 'vertical') : null;

  if (style === 'overlay' && !division) {
    const h = Math.round(bounds.h * 0.38);
    return { primary: full, secondary: { x: 0, y: bounds.h - h, w: bounds.w, h }, secondaryZIndex: 1, axis: null };
  }

  const axis = divisionAxis ?? (bounds.w > bounds.h ? 'horizontal' : 'vertical');
  if (!axes.includes(axis)) return { primary: full, secondary: null, secondaryZIndex: 0, axis: null };

  const length = axis === 'horizontal' ? bounds.w : bounds.h;
  let a: number;
  let b: number;
  if (division) {
    a = axis === 'horizontal' ? division.frame.x : division.frame.y;
    b = axis === 'horizontal' ? division.frame.x + division.frame.w : division.frame.y + division.frame.h;
  } else {
    a = b = length / 2;
  }
  if (a < MIN_PANE || length - b < MIN_PANE) return { primary: full, secondary: null, secondaryZIndex: 0, axis: null };

  const first: Rect = axis === 'horizontal' ? { x: 0, y: 0, w: a, h: bounds.h } : { x: 0, y: 0, w: bounds.w, h: a };
  const second: Rect = axis === 'horizontal' ? { x: b, y: 0, w: bounds.w - b, h: bounds.h } : { x: 0, y: b, w: bounds.w, h: bounds.h - b };
  return { primary: first, secondary: second, secondaryZIndex: 0, axis };
}
