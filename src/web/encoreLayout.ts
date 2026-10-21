// Layout of "Encore", the demo music app, before and after duo-ready's fixes.
// Pure geometry so the claims the lab makes ("no collisions after fixes") are testable.

import { arrange, intersect, present, type Arrangement, type Posture, type Presentation, type Rect } from '../core/duo';
import type { SdkTier } from '../core/types';

export type Build = 'legacy-26' | 'legacy-27' | 'legacy-27.1' | 'ready';

export const BUILDS: { id: Build; tier: SdkTier; label: string; detail: string }[] = [
  { id: 'legacy-26', tier: '26', label: 'iOS 26 SDK', detail: 'Today: the app as shipped' },
  { id: 'legacy-27', tier: '27', label: 'iOS 27 SDK', detail: 'Rebuilt, code unchanged' },
  { id: 'legacy-27.1', tier: '27.1', label: 'iOS 27.1 SDK', detail: 'Rebuilt, code unchanged' },
  { id: 'ready', tier: '27.1', label: '27.1 + duo-ready', detail: 'Rebuilt with fixes applied' },
];

export type PieceRole = 'bar' | 'rail' | 'artwork' | 'title' | 'controls' | 'list' | 'mini';

export interface Piece {
  role: PieceRole;
  label: string;
  rect: Rect;
  /** duo-ready rule that explains why this piece misbehaves. */
  rule?: string;
}

export interface Collision {
  piece: Piece;
  obstacle: 'hinge' | 'camera' | 'status bar';
  rect: Rect;
}

export interface EncoreLayout {
  presentation: Presentation;
  pieces: Piece[];
  collisions: Collision[];
  arrangement: Arrangement | null;
  /** Share of the window's width the main content uses. */
  contentWidth: number;
}

const NAV = 44;
const TAB = 50;
const LEGACY_COLUMN = 390;

function player(r: Rect): Piece[] {
  const pad = 16;
  const below = 16 + 40 + 48;
  const side = Math.max(0, Math.min(r.w - pad * 2, r.h - pad * 2 - below));
  const top = r.y + (r.h - side - below) / 2;
  const x = r.x + (r.w - side) / 2;
  const width = Math.min(r.w - pad * 2, Math.max(side, 220));
  const tx = r.x + (r.w - width) / 2;
  return [
    { role: 'artwork', label: 'Artwork', rect: { x, y: top, w: side, h: side } },
    { role: 'title', label: 'Track title', rect: { x: tx, y: top + side + 16, w: width, h: 40 } },
    { role: 'controls', label: 'Playback controls', rect: { x: tx, y: top + side + 56, w: width, h: 48 } },
  ];
}

function legacy(p: Presentation, fullWidth: boolean, flagBars: boolean): Piece[] {
  const { w: W, h: H } = p.window;
  // The old code reads only the top and bottom insets and assumes a 390 pt iPhone.
  const top = p.safeArea.top;
  const bottom = p.safeArea.bottom;
  const colW = fullWidth ? W : Math.min(W, LEGACY_COLUMN);
  const colX = (W - colW) / 2;
  const tabY = H - bottom - TAB;
  const body = player({ x: colX, y: top + NAV, w: colW, h: tabY - top - NAV });
  const sized = colW < W ? 'fixed-device-size' : undefined;
  return [
    { role: 'bar', label: 'Custom navigation bar', rect: { x: 0, y: top, w: W, h: NAV }, rule: flagBars ? 'hand-built-bar' : undefined },
    ...body.map((piece) => ({ ...piece, rule: sized })),
    { role: 'bar', label: 'Custom tab bar', rect: { x: 0, y: tabY, w: W, h: TAB }, rule: flagBars ? 'hand-built-bar' : undefined },
  ];
}

function ready(p: Presentation): { pieces: Piece[]; arrangement: Arrangement } {
  const { w: W, h: H } = p.window;
  const sa = p.safeArea;
  const pieces: Piece[] = [];
  let content: Rect;
  if (p.bars === 'vertical') {
    const railTop = p.statusBar ? p.statusBar.y + p.statusBar.h : sa.top;
    pieces.push({ role: 'rail', label: 'System tab bar (vertical)', rect: { x: W - sa.right, y: railTop, w: sa.right, h: H - sa.bottom - railTop } });
    content = { x: sa.left, y: sa.top, w: W - sa.left - sa.right, h: H - sa.top - sa.bottom };
  } else {
    content = { x: sa.left, y: sa.top, w: W - sa.left - sa.right, h: H - sa.top - sa.bottom - TAB };
    pieces.push({ role: 'bar', label: 'System tab bar', rect: { x: sa.left, y: content.y + content.h, w: content.w, h: TAB } });
  }
  const local = p.regions.flatMap((r) => {
    const clipped = intersect(r.frame, content);
    return clipped ? [{ ...r, frame: { ...clipped, x: clipped.x - content.x, y: clipped.y - content.y } }] : [];
  });
  const a = arrange(content, local, 'split');
  const shift = (r: Rect): Rect => ({ ...r, x: r.x + content.x, y: r.y + content.y });
  const primary = shift(a.primary);
  if (a.secondary) {
    pieces.push(...player(primary), { role: 'list', label: 'Up next', rect: shift(a.secondary) });
  } else {
    const mini: Rect = { x: primary.x + 12, y: primary.y + primary.h - 56, w: primary.w - 24, h: 44 };
    pieces.push(...player({ ...primary, h: primary.h - 60 }), { role: 'mini', label: 'Up next', rect: mini });
  }
  return { pieces, arrangement: a };
}

const area = (r: Rect) => r.w * r.h;

export function layoutEncore(posture: Posture, build: Build, cameraActive = false): EncoreLayout {
  const tier = BUILDS.find((b) => b.id === build)!.tier;
  const p = present(posture, tier, cameraActive);
  const compat = p.display === 'inner' && tier === '26';
  let pieces: Piece[];
  let arrangement: Arrangement | null = null;
  if (build === 'ready') ({ pieces, arrangement } = ready(p));
  else pieces = legacy(p, compat || p.display === 'outer', tier !== '26');

  const obstacles: { obstacle: Collision['obstacle']; rect: Rect }[] = [];
  for (const r of p.regions) if (r.active) obstacles.push({ obstacle: r.kind === 'division' ? 'hinge' : 'camera', rect: r.frame });
  if (p.statusBar) obstacles.push({ obstacle: 'status bar', rect: p.statusBar });

  const collisions: Collision[] = [];
  for (const piece of pieces) {
    for (const o of obstacles) {
      const hit = intersect(piece.rect, o.rect);
      if (hit && area(hit) > 0.5) collisions.push({ piece, obstacle: o.obstacle, rect: hit });
    }
  }
  const body = pieces.filter((x) => x.role !== 'bar' && x.role !== 'rail');
  const left = Math.min(...body.map((x) => x.rect.x));
  const right = Math.max(...body.map((x) => x.rect.x + x.rect.w));
  return { presentation: p, pieces, collisions, arrangement, contentWidth: (right - left) / p.window.w };
}
