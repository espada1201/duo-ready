export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r < x || bt < y) return null;
  return { x, y, w: r - x, h: bt - y };
}

export const area = (r: { w: number; h: number }) => r.w * r.h;

export const translate = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });

/** The part of `r` inside `frame`, in `frame`'s coordinates. */
export function clipTo(r: Rect, frame: Rect): Rect | null {
  const hit = intersect(r, frame);
  return hit && translate(hit, -frame.x, -frame.y);
}
