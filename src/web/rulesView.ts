import { RULES } from '../core/rules';
import { h } from './dom';

const CLI = `# In your app's folder, with this repo cloned next to it
npm run audit -- ../MyApp              # report
npm run audit -- ../MyApp --dry-run    # show the fixes as a diff
npm run audit -- ../MyApp --fix        # apply the safe fixes`;

const ACTION = `# .github/workflows/duo.yml in your app's repo: findings show up on pull requests
- uses: actions/checkout@v4
  with: { repository: espada1201/duo-ready, path: .duo-ready }
- run: cd .duo-ready && npm ci && npm run audit -- .. --format sarif --out ../duo.sarif --fail-on never
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: duo.sarif }`;

export function renderRules(focus: string | null): HTMLElement {
  const view = h(
    'div',
    { class: 'rules' },
    h('div', { class: 'rules-intro' }, h('h2', {}, 'The rules'), h('p', {}, `${RULES.length} checks, each traced to Apple’s iPhone Duo guidance.`)),
    h(
      'ol',
      { class: 'rule-list' },
      RULES.map((r) =>
        h(
          'li',
          { id: `rule-${r.id}`, class: `rule${r.id === focus ? ' focus' : ''}`, tabindex: '-1' },
          h('div', { class: 'finding-head' }, h('span', { class: `chip chip-${r.severity}` }, r.severity === 'info' ? 'note' : r.severity), h('strong', {}, r.title)),
          h('code', { class: 'rule-id' }, r.id),
          h('p', {}, r.why),
          h('p', { class: 'instead' }, h('span', {}, 'Instead: '), r.instead),
          h('p', { class: 'hint' }, r.source),
        ),
      ),
    ),
    h(
      'section',
      { class: 'cli' },
      h('h2', {}, 'Use it from the terminal or CI'),
      h('p', {}, 'The same engine ships as a command-line tool. It prints a report, applies fixes in place, and writes SARIF so GitHub shows findings on pull requests.'),
      h('pre', {}, h('code', {}, CLI)),
      h('pre', {}, h('code', {}, ACTION)),
    ),
  );
  if (focus) requestAnimationFrame(() => document.getElementById(`rule-${focus}`)?.focus());
  return view;
}
