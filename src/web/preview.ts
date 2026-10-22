import { POSTURES, statusBarRect, type Posture, type Presentation } from '../core/duo';
import type { Rect } from '../core/rect';
import { RULE_BY_ID } from '../core/rules';
import { groupBy, joinEnglish } from '../core/text';
import { h, segmented, toggle } from './dom';
import { buildTier, BUILDS, continuity, layoutEncore, RECOMMENDED, type Build, type EncoreLayout, type Piece } from './encoreLayout';
import { icon } from './icons';

export interface PreviewState {
  posture: Posture;
  build: Build;
  regions: boolean;
  safeArea: boolean;
  camera: boolean;
  screenshot: string | null;
  /** The pose before the last change, for the fold continuity check. */
  previous: Posture | null;
}

const TRACKS = ['Low Tide', 'Paper Lanterns', 'Overpass', 'Static Bloom', 'Half Light', 'North Window', 'Glass Hours', 'Undertow', 'Small Hours'];
const BEZEL = 10;

const px = (r: Rect, s: number) => `left:${r.x * s}px;top:${r.y * s}px;width:${r.w * s}px;height:${r.h * s}px`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const fmt = (r: Rect) => `${Math.round(r.w)} × ${Math.round(r.h)} pt at (${Math.round(r.x)}, ${Math.round(r.y)})`;

function piece(p: Piece, s: number): HTMLElement {
  const style = px(p.rect, s);
  const icons = (names: string[], size: number) => names.map((n) => icon(n, size));
  switch (p.role) {
    case 'bar':
      if (p.label.includes('navigation')) {
        return h(
          'div',
          { class: `enc-bar enc-nav${p.rule ? ' enc-custom' : ''}`, style: `${style};font-size:${Math.max(7, 15 * s)}px` },
          h('span', {}, '‹ Library'),
          h('strong', {}, 'Now Playing'),
          h('span', {}, ''),
        );
      }
      return h('div', { class: `enc-bar${p.rule ? ' enc-custom' : ''}`, style }, icons(['library', 'search', 'radio', 'person'], Math.max(10, 20 * s)));
    case 'rail':
      return h('div', { class: 'enc-rail', style }, icons(['library', 'search', 'radio', 'person'], Math.max(10, 20 * s)));
    case 'artwork':
      return h('div', { class: 'enc-art', style }, h('span', { style: `font-size:${Math.max(8, 13 * s)}px` }, 'ENCORE'));
    case 'title':
      return h(
        'div',
        { class: 'enc-title', style: `${style};font-size:${Math.max(7, 15 * s)}px` },
        h('strong', {}, 'Night Drive'),
        h('span', {}, 'The Parallels'),
      );
    case 'controls':
      return h('div', { class: 'enc-controls', style }, icons(['prev', 'play', 'next'], Math.max(10, 26 * s)));
    case 'list': {
      const rowH = 44;
      const rows = Math.max(0, Math.floor((p.rect.h - 48) / rowH));
      return h(
        'div',
        { class: 'enc-list', style: `${style};font-size:${Math.max(7, 14 * s)}px` },
        h('div', { class: 'enc-list-head' }, 'Up next'),
        TRACKS.slice(0, rows).map((t, i) =>
          h('div', { class: 'enc-row', style: `height:${rowH * s}px` }, h('i', { style: `--hue:${(i * 47) % 360}` }), h('span', {}, t)),
        ),
      );
    }
    case 'mini':
      return h('div', { class: 'enc-mini', style: `${style};font-size:${Math.max(7, 13 * s)}px` }, `Up next · ${TRACKS.length} tracks`);
  }
}

function statusBar(p: Presentation, s: number, compat: boolean): HTMLElement | null {
  if (compat) return null;
  const landscape = p.screen.w > p.screen.h;
  // Over the app's light background the status bar draws dark; over black it draws light.
  const overApp = !!p.statusBar;
  const r = statusBarRect(p.screen);
  return h(
    'div',
    { class: `status${landscape ? ' status-side' : ''}${overApp ? ' status-dark' : ''}`, style: `${px(r, s)};font-size:${Math.max(7, 13 * s)}px`, 'aria-hidden': 'true' },
    h('span', {}, '9:41'),
    h('i', { class: 'battery' }),
  );
}

function renderStage(layout: EncoreLayout, state: PreviewState, width: number): HTMLElement {
  const p = layout.presentation;
  const maxH = Math.min(window.innerHeight * 0.62, 560);
  const s = Math.min((width - 24 - BEZEL * 2) / p.screen.w, (maxH - BEZEL * 2) / p.screen.h);
  const compat = p.display === 'inner' && buildTier(state.build) === '26';
  const folded = state.posture === 'book' || state.posture === 'tent';
  const vertical = p.bars === 'vertical';

  const win = h('div', { class: 'app-window', style: px(p.window, s) });
  if (compat && state.screenshot) {
    win.appendChild(h('img', { class: 'shot', src: state.screenshot, alt: 'Your app screenshot in the compatibility window' }));
  } else {
    for (const x of layout.pieces) win.appendChild(piece(x, s));
  }
  if (compat) {
    win.appendChild(
      h('div', { class: 'status compat-status', style: `height:${p.safeArea.top * s}px;font-size:${Math.max(7, 12 * s)}px` }, h('span', {}, '9:41'), h('i', { class: 'battery' })),
    );
  }
  if (state.safeArea) {
    const sa = p.safeArea;
    win.appendChild(
      h('div', {
        class: 'overlay-safe',
        style: px({ x: sa.left, y: sa.top, w: p.window.w - sa.left - sa.right, h: p.window.h - sa.top - sa.bottom }, s),
        title: 'Safe area',
      }),
    );
  }
  if (state.regions) {
    for (const r of p.regions) {
      if (!r.active) continue;
      win.appendChild(
        h('div', { class: `overlay-region overlay-${r.kind}`, style: px(r.frame, s), title: `${r.kind} region` }, r.kind === 'division' ? h('span', {}, 'division') : null),
      );
    }
  }
  for (const c of layout.collisions) {
    win.appendChild(h('div', { class: 'overlay-collision', style: px(c.rect, s), title: `${c.piece.label} collides with the ${c.obstacle}` }));
  }

  const screen = h(
    'div',
    {
      class: `screen${folded ? ` folded folded-${p.screen.w > p.screen.h ? 'v' : 'h'}` : ''}`,
      style: `width:${p.screen.w * s}px;height:${p.screen.h * s}px`,
    },
    p.share < 1 ? h('div', { class: 'other-app', style: px({ x: p.screen.w * p.share, y: 0, w: p.screen.w * (1 - p.share), h: p.screen.h }, s) }, 'Another app') : null,
    win,
    statusBar(p, s, compat),
  );
  const camera = state.camera && p.display === 'inner' ? p.regions.find((r) => r.kind === 'occlusion') : null;
  if (camera) {
    const f = { x: camera.frame.x + p.window.x, y: camera.frame.y + p.window.y, w: camera.frame.w, h: camera.frame.h };
    screen.appendChild(h('div', { class: 'camera-dot', style: px(f, s), 'aria-hidden': 'true' }));
  }

  return h(
    'figure',
    { class: 'stage', 'data-display': p.display },
    h('div', { class: `device device-${p.display}`, style: `padding:${BEZEL}px` }, screen),
    h(
      'figcaption',
      {},
      `${POSTURES.find((x) => x.id === state.posture)!.detail}. `,
      compat ? 'Old SDK: iOS shows the app in an iPhone-sized window.' : vertical ? 'System bars run vertically under the status bar.' : '',
    ),
  );
}

function readout(layout: EncoreLayout, state: PreviewState): HTMLElement {
  const p = layout.presentation;
  const sa = p.safeArea;
  const insets = `top ${Math.round(sa.top)}, leading ${Math.round(sa.left)}, bottom ${Math.round(sa.bottom)}, trailing ${Math.round(sa.right)}`;
  const regions = p.regions.length
    ? p.regions.map((r) => h('li', {}, h('code', {}, `.${r.kind}`), ` ${r.active ? 'active' : 'inactive'}, ${fmt(r.frame)}`))
    : [h('li', {}, 'None on this display')];
  const problems: HTMLElement[] = [];
  for (const [obstacle, hits] of groupBy(layout.collisions, (c) => c.obstacle)) {
    const what = [...new Set(hits.map((c) => c.piece.label.toLowerCase()))];
    problems.push(h('li', { class: 'problem' }, `The ${obstacle} cuts through the ${joinEnglish(what)}.`));
  }
  const flagged = [...new Set(layout.pieces.map((x) => x.rule).filter(Boolean) as string[])];
  for (const id of flagged) problems.push(h('li', { class: 'problem' }, RULE_BY_ID.get(id)!.title, '. ', h('a', { href: `#rules/${id}` }, 'Why')));
  const space = p.share < 1 ? 'its half of the display' : 'the display';
  if (p.coverage < 0.98) problems.unshift(h('li', { class: 'problem' }, `${pct(1 - p.coverage)} of ${space} is left black.`));
  if (layout.contentWidth < 0.6 && p.display === 'inner') problems.push(h('li', { class: 'problem' }, `Content uses only ${pct(layout.contentWidth)} of the window’s width.`));

  return h(
    'section',
    { class: 'readout', 'aria-label': 'What the app sees', 'aria-live': 'polite' },
    h('h3', {}, 'What the app sees'),
    h(
      'dl',
      {},
      h('dt', {}, 'Display'),
      h('dd', {}, `${p.display === 'inner' ? 'Inner 7.6″' : 'Outer 5.4″'}, ${Math.round(p.screen.w)} × ${Math.round(p.screen.h)} pt`),
      h('dt', {}, 'App window'),
      h('dd', { 'data-testid': 'window' }, `${Math.round(p.window.w)} × ${Math.round(p.window.h)} pt, ${pct(p.coverage)} of ${space}`),
      h('dt', {}, 'Size classes'),
      h('dd', {}, `${p.sizeClass.horizontal} width, ${p.sizeClass.vertical} height`),
      h('dt', {}, 'Safe area'),
      h('dd', {}, insets),
      h('dt', {}, 'Bars'),
      h('dd', {}, p.bars),
      h('dt', {}, 'Reserved regions'),
      h('dd', {}, h('ul', { class: 'plain' }, regions)),
    ),
    h('h3', {}, problems.length ? `Problems in this pose (${problems.length})` : 'Problems in this pose'),
    problems.length
      ? h('ul', { class: 'problems', 'data-testid': 'problems' }, problems)
      : h('p', { class: 'all-clear', 'data-testid': 'problems' }, icon('check', 16), ' No collisions. Content stays clear of the hinge, camera and status bar.'),
    foldCheck(state),
    state.build === 'ready' ? changes() : null,
    state.build === 'ready' ? snippet(layout) : null,
  );
}

function foldCheck(state: PreviewState): HTMLElement {
  const label = (id: Posture) => POSTURES.find((p) => p.id === id)!.label.toLowerCase();
  if (!state.previous) {
    return h('div', { class: 'fold-check', 'data-testid': 'continuity' }, h('h3', {}, 'Fold test'), h('p', { class: 'hint' }, 'Switch between Closed and Open to see whether Encore keeps your place.'));
  }
  const c = continuity(state.previous, state.posture, state.build);
  return h(
    'div',
    { class: 'fold-check', 'data-testid': 'continuity' },
    h('h3', {}, `Fold test: ${label(state.previous)} → ${label(state.posture)}`),
    c.lost.length
      ? h(
          'p',
          { class: 'problem' },
          `The size class changed and Encore rebuilt its views. Lost: ${joinEnglish(c.lost)}. `,
          h('a', { href: '#rules/state-reset' }, 'Why'),
        )
      : h(
          'p',
          { class: 'all-clear' },
          icon('check', 16),
          c.resized ? ` Kept ${joinEnglish(c.kept)}: the layout changed, the views didn’t.` : ' The size class didn’t change, so nothing was rebuilt.',
        ),
  );
}

const HOW = { automatic: 'duo-ready applies', review: 'duo-ready suggests, you review', manual: 'You change' };

function changes(): HTMLElement {
  return h(
    'div',
    { class: 'changes', 'data-testid': 'changes' },
    h('h3', {}, 'What changed in this build'),
    [...groupBy(RECOMMENDED, (c) => c.how)].map(([how, items]) =>
      h(
        'div',
        { class: `how-${how}` },
        h('p', { class: 'how' }, HOW[how]),
        h('ul', {}, items.map((c) => h('li', {}, `${c.change}. `, h('a', { href: `#rules/${c.rule}` }, 'Why')))),
      ),
    ),
  );
}

function snippet(layout: EncoreLayout): HTMLElement {
  const split = !!layout.arrangement?.secondary;
  const code = `NavigationStack {
  ArrangementView {
    PlayerView()
  } secondary: {
    UpNextView()
  }
}
// ${split ? `split ${layout.arrangement!.axis === 'horizontal' ? 'side by side' : 'top and bottom'}` : 'only the primary view fits here'}`;
  return h('details', { class: 'snippet' }, h('summary', {}, 'The SwiftUI behind this layout'), h('pre', {}, h('code', {}, code)));
}

let observer: ResizeObserver | null = null;

export function renderPreview(state: PreviewState, set: (patch: Partial<PreviewState>) => void): HTMLElement {
  const layout = layoutEncore(state.posture, state.build, state.camera);
  const stageHost = h('div', { class: 'stage-host' });
  const paint = () => {
    stageHost.replaceChildren(renderStage(layout, state, stageHost.clientWidth || 600));
  };
  observer?.disconnect();
  observer = new ResizeObserver(paint);
  observer.observe(stageHost);

  const onShot = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (state.screenshot) URL.revokeObjectURL(state.screenshot);
    set({ screenshot: URL.createObjectURL(file), build: 'legacy-26', posture: state.posture === 'closed' || state.posture === 'closed-landscape' ? 'open' : state.posture });
  };

  const controls = h(
    'div',
    { class: 'controls' },
    segmented(
      'Pose',
      POSTURES.map((p) => ({ value: p.id, label: p.label, title: p.detail })),
      state.posture,
      (posture) => set({ posture, previous: state.posture }),
      'poses',
    ),
    segmented(
      'Build',
      BUILDS.map((b) => ({ value: b.id, label: b.label, title: b.detail })),
      state.build,
      (build) => set({ build }),
      'builds',
    ),
    h(
      'div',
      { class: 'toggles' },
      toggle('Reserved regions', state.regions, (regions) => set({ regions })),
      toggle('Safe area', state.safeArea, (safeArea) => set({ safeArea })),
      toggle('Camera in use', state.camera, (camera) => set({ camera })),
    ),
    h(
      'div',
      { class: 'shot-row' },
      h(
        'label',
        { class: 'button ghost' },
        icon('upload', 16),
        h('span', {}, state.screenshot ? 'Change screenshot' : 'Try your own screenshot'),
        h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', onchange: onShot, 'data-testid': 'shot-input' }),
      ),
      state.screenshot
        ? h('button', { class: 'button ghost', type: 'button', onclick: () => {
            URL.revokeObjectURL(state.screenshot!);
            set({ screenshot: null });
          } }, 'Remove')
        : h('span', { class: 'hint' }, 'See how your current iPhone app opens on the inner display.'),
    ),
  );

  return h(
    'div',
    { class: 'preview' },
    h(
      'div',
      { class: 'preview-intro' },
      h('h2', {}, 'See what Duo users see'),
      h(
        'p',
        {},
        'Encore is a typical iPhone music app. Step through the builds: as shipped, rebuilt with each new SDK, and rebuilt with the changes duo-ready recommends. Then fold the phone, or share the screen in Split View.',
      ),
    ),
    h('div', { class: 'preview-grid' }, h('div', { class: 'preview-main' }, controls, stageHost), readout(layout, state)),
    h('p', { class: 'fineprint' }, 'Panel sizes come from Apple’s published specs at 3x. Status bar, hinge and camera geometry are approximations. Confirm in the iPhone Duo simulator in Xcode 27.1.'),
  );
}
