import { svg } from './dom';

// Small stroke icons, drawn on a 24 grid.
const PATHS: Record<string, string> = {
  play: 'M8 5.5v13l10-6.5z',
  prev: 'M7 6v12M18 6l-8.5 6 8.5 6z',
  next: 'M17 6v12M6 6l8.5 6L6 18z',
  library: 'M5 4v16M10 4v16M15 4.5l4.5 15',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  radio: 'M4 9h16v11H4zM8 5l9 4M12 15.5a1.5 1.5 0 1 0 0-.01',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20c1-4 4-5.5 7-5.5s6 1.5 7 5.5',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  folder: 'M3.5 6.5h6l2 2h9v10h-17z',
  doc: 'M6 3.5h8l4 4v13H6zM14 3.5v4h4',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};

const SOLID = new Set(['play', 'prev', 'next']);

export function icon(name: string, size = 18): SVGSVGElement {
  const cls = SOLID.has(name) ? 'icon icon-solid' : 'icon';
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: cls }, svg('path', { d: PATHS[name] ?? '' }));
}
