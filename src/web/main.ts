import './styles.css';
import type { SdkTier } from '../core/types';
import { h } from './dom';
import { initialAudit, renderAudit, type AuditState } from './auditView';
import { BUILDS } from './encoreLayout';
import { renderPreview, type PreviewState } from './preview';
import { renderRules } from './rulesView';

type Tab = 'preview' | 'audit' | 'rules';
const TABS: { id: Tab; label: string }[] = [
  { id: 'preview', label: 'Preview' },
  { id: 'audit', label: 'Audit' },
  { id: 'rules', label: 'Why it breaks' },
];

let preview: PreviewState = { posture: 'open', build: 'legacy-26', regions: true, safeArea: false, camera: false, screenshot: null, previous: null };
let auditState: AuditState = initialAudit();
const root = document.getElementById('app')!;

function route(): { tab: Tab; focus: string | null } {
  const [tab, focus] = location.hash.slice(1).split('/');
  return { tab: TABS.some((t) => t.id === tab) ? (tab as Tab) : 'preview', focus: focus ?? null };
}

function mark(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="3" y="6" width="12" height="20" rx="3"/><rect x="17" y="6" width="12" height="20" rx="3"/>';
  return svg;
}

function render() {
  const { tab, focus } = route();
  const panel =
    tab === 'preview'
      ? renderPreview(preview, (patch) => {
          preview = { ...preview, ...patch };
          render();
        })
      : tab === 'audit'
        ? renderAudit(
            auditState,
            (s) => {
              auditState = s;
              render();
            },
            (tier) => {
              const build = BUILDS.find((b) => b.id !== 'ready' && b.tier === (tier as SdkTier));
              preview = { ...preview, build: build?.id ?? 'legacy-26' };
              location.hash = 'preview';
            },
          )
        : renderRules(focus);

  const active = document.activeElement;
  const activeKey = active instanceof HTMLInputElement ? `${active.name}|${active.value}|${active.type}` : null;

  root.replaceChildren(
    h(
      'a',
      {
        class: 'skip',
        href: '#main',
        // Hash links drive routing here, so move focus without touching the URL.
        onclick: (e: Event) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        },
      },
      'Skip to content',
    ),
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#preview' }, mark(), h('span', {}, 'duo-ready')),
      h(
        'nav',
        { 'aria-label': 'Sections' },
        TABS.map((t) => h('a', { href: `#${t.id}`, 'aria-current': t.id === tab ? 'page' : null }, t.label)),
      ),
    ),
    h('main', { id: 'main', tabindex: '-1' }, panel),
    h('footer', {}, 'duo-ready · an open toolkit for making existing iPhone apps ready for iPhone Duo. Not affiliated with Apple.'),
  );

  // Keep keyboard focus on the control that triggered a re-render.
  if (activeKey) {
    for (const input of root.querySelectorAll('input')) {
      if (`${input.name}|${input.value}|${input.type}` === activeKey) {
        input.focus();
        break;
      }
    }
  }
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
render();
