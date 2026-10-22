import { describe, expect, it } from 'vitest';
import { POSTURES } from '../../src/core/duo';
import { continuity, layoutEncore } from '../../src/web/encoreLayout';

const inside = (r: { x: number; y: number; w: number; h: number }, w: number, h: number) =>
  r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= w + 0.01 && r.y + r.h <= h + 0.01 && r.w >= 0 && r.h >= 0;

describe('Encore demo layout', () => {
  it('after duo-ready fixes, nothing collides with the hinge, camera or status bar in any pose', () => {
    for (const { id } of POSTURES) {
      for (const camera of [false, true]) {
        const l = layoutEncore(id, 'ready', camera);
        expect(l.collisions, `${id} camera=${camera}`).toEqual([]);
        for (const piece of l.pieces) expect(inside(piece.rect, l.presentation.window.w, l.presentation.window.h), `${id} ${piece.label}`).toBe(true);
      }
    }
  });

  it('uses two panes on the open inner display and splits at the hinge when folded', () => {
    expect(layoutEncore('open', 'ready').arrangement?.secondary).not.toBeNull();
    const book = layoutEncore('book', 'ready');
    const hinge = book.presentation.regions.find((r) => r.kind === 'division')!;
    const list = book.pieces.find((p) => p.role === 'list')!;
    expect(list.rect.x).toBeGreaterThanOrEqual(hinge.frame.x + hinge.frame.w);
    expect(layoutEncore('closed', 'ready').arrangement?.secondary).toBeNull();
  });

  it('reproduces the reviewers’ problems with unchanged code', () => {
    const book = layoutEncore('book', 'legacy-27.1');
    expect(book.collisions.some((c) => c.obstacle === 'hinge' && c.piece.role === 'artwork')).toBe(true);
    expect(layoutEncore('open', 'legacy-27.1').collisions.some((c) => c.obstacle === 'status bar')).toBe(true);
    expect(layoutEncore('open', 'legacy-27').contentWidth).toBeLessThan(0.5);
    expect(layoutEncore('open', 'legacy-26').presentation.coverage).toBeLessThan(0.5);
    expect(layoutEncore('book', 'legacy-26').collisions.some((c) => c.obstacle === 'hinge')).toBe(true);
  });

  it('the fixed app uses more of the open display than any unchanged build', () => {
    const used = (b: Parameters<typeof layoutEncore>[1]) => {
      const l = layoutEncore('open', b);
      return l.contentWidth * l.presentation.window.w;
    };
    expect(used('ready')).toBeGreaterThan(used('legacy-27.1'));
    expect(used('ready')).toBeGreaterThan(used('legacy-26'));
  });
});

describe('fold continuity', () => {
  it('unchanged code loses its place when opening changes the size class; the fixed build keeps it', () => {
    expect(continuity('closed', 'open', 'legacy-27.1').lost.length).toBeGreaterThan(0);
    expect(continuity('closed', 'open', 'ready')).toMatchObject({ resized: true, lost: [] });
  });

  it('old-SDK apps keep their place because the compatibility window never changes size class', () => {
    expect(continuity('closed', 'open', 'legacy-26')).toMatchObject({ resized: false, lost: [] });
  });

  it('folding to book keeps the size class, so nothing is rebuilt', () => {
    expect(continuity('open', 'book', 'legacy-27.1').resized).toBe(false);
  });
});
