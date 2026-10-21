import { describe, expect, it } from 'vitest';
import { arrange, INNER, MIN_PANE, OUTER, POSTURES, present } from '../../src/core/duo';

describe('Duo display model', () => {
  it('derives point sizes from Apple’s published panel pixels at 3x', () => {
    expect(INNER).toEqual({ w: 890, h: 626 });
    expect(OUTER).toEqual({ w: 466, h: 678 });
    // 7.6" and 5.4" diagonals at Apple's stated 430 and 460 ppi.
    expect(Math.hypot(2670, 1878) / 430).toBeCloseTo(7.6, 1);
    expect(Math.hypot(1398, 2034) / 460).toBeCloseTo(5.4, 1);
  });

  it('matches Apple’s size class table for iOS 27.1 apps', () => {
    const sc = (p: Parameters<typeof present>[0]) => present(p, '27.1').sizeClass;
    expect(sc('closed')).toEqual({ horizontal: 'compact', vertical: 'regular' });
    expect(sc('closed-landscape')).toEqual({ horizontal: 'compact', vertical: 'compact' });
    for (const p of ['open', 'open-portrait', 'book', 'tent'] as const) expect(sc(p)).toEqual({ horizontal: 'regular', vertical: 'regular' });
  });

  it('shows the three SDK tiers getting progressively more of the inner display', () => {
    const [t26, t27, t271] = (['26', '27', '27.1'] as const).map((t) => present('open', t));
    expect(t26.coverage).toBeLessThan(0.5);
    expect(t26.window.x).toBeGreaterThan(0);
    expect(t26.window.x * 2 + t26.window.w).toBeCloseTo(INNER.w);
    expect(t26.sizeClass.horizontal).toBe('compact');
    expect(t27.coverage).toBeGreaterThan(0.9);
    expect(t27.coverage).toBeLessThan(1);
    expect(t27.bars).toBe('horizontal');
    expect(t271.coverage).toBe(1);
    expect(t271.bars).toBe('vertical');
    expect(t271.safeArea.right).toBeGreaterThan(0);
    expect(t271.safeArea.left).toBe(0);
  });

  it('leaves the outer display alone for old apps when held upright', () => {
    expect(present('closed', '26').coverage).toBe(1);
    expect(present('closed', '26').window).toEqual(present('closed', '27.1').window);
  });

  it('runs the hinge straight through the middle of a legacy app when folded', () => {
    const legacy = present('book', '26');
    const hinge = legacy.regions.find((r) => r.kind === 'division')!;
    expect(hinge.active).toBe(true);
    expect(hinge.frame.x + hinge.frame.w / 2).toBeCloseTo(legacy.window.w / 2);
    expect(hinge.frame.h).toBeCloseTo(legacy.window.h);
  });

  it('reports inactive divisions with zero width when flat, and occlusion only with the camera on', () => {
    const flat = present('open', '27.1');
    expect(flat.regions.find((r) => r.kind === 'division')).toMatchObject({ active: false, frame: { w: 0 } });
    expect(flat.regions.find((r) => r.kind === 'occlusion')?.active).toBe(false);
    expect(present('open', '27.1', true).regions.find((r) => r.kind === 'occlusion')?.active).toBe(true);
    expect(present('closed', '27.1').regions).toEqual([]);
  });

  it('turns the fold across the screen when propped up', () => {
    const tent = present('tent', '27.1');
    const hinge = tent.regions.find((r) => r.kind === 'division')!;
    expect(hinge.frame.w).toBe(tent.window.w);
    expect(hinge.frame.y + hinge.frame.h / 2).toBeCloseTo(tent.window.h / 2);
  });

  it('has a label for every posture', () => {
    expect(new Set(POSTURES.map((p) => p.id)).size).toBe(6);
  });
});

describe('arrange (ArrangementView model)', () => {
  const regions = (p: Parameters<typeof present>[0]) => present(p, '27.1').regions;

  it('splits wide canvases side by side and tall canvases top and bottom', () => {
    const wide = arrange({ w: 890, h: 626 }, regions('open'), 'split');
    expect(wide.axis).toBe('horizontal');
    expect(wide.primary.w + wide.secondary!.w).toBe(890);
    const tall = arrange({ w: 626, h: 890 }, regions('open-portrait'), 'split');
    expect(tall.axis).toBe('vertical');
  });

  it('splits exactly at an active hinge so neither pane sits under it', () => {
    const p = present('book', '27.1');
    const hinge = p.regions.find((r) => r.kind === 'division')!;
    const a = arrange(p.window, p.regions, 'split');
    expect(a.primary.x + a.primary.w).toBe(hinge.frame.x);
    expect(a.secondary!.x).toBe(hinge.frame.x + hinge.frame.w);
  });

  it('shows only the primary view when panes would be too small or the axis is not allowed', () => {
    expect(arrange({ w: 466, h: 678 }, [], 'split').secondary).toBeNull();
    expect(arrange({ w: MIN_PANE * 2, h: 400 }, [], 'split').secondary).not.toBeNull();
    expect(arrange({ w: 626, h: 890 }, [], 'split', ['horizontal']).secondary).toBeNull();
  });

  it('overlays when flat and goes side by side when folded', () => {
    const flat = arrange({ w: 890, h: 626 }, regions('open'), 'overlay');
    expect(flat.secondaryZIndex).toBe(1);
    expect(flat.primary).toEqual({ x: 0, y: 0, w: 890, h: 626 });
    const folded = arrange({ w: 890, h: 626 }, regions('book'), 'overlay');
    expect(folded.secondaryZIndex).toBe(0);
    expect(folded.axis).toBe('horizontal');
  });
});

describe('status bar', () => {
  it('sits on top in portrait, in the trailing strip in landscape, and outside old apps’ windows', () => {
    expect(present('closed', '27.1').statusBar).toMatchObject({ x: 0, y: 0, w: OUTER.w });
    const open = present('open', '27.1');
    expect(open.statusBar!.x + open.statusBar!.w).toBe(open.window.w);
    expect(open.statusBar!.x).toBe(open.window.w - open.safeArea.right);
    expect(present('open', '27').statusBar).toBeNull();
    expect(present('open', '26').statusBar).toBeNull();
  });
});
