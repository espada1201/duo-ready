import { PAIN_POINTS } from '../core/painPoints';
import { RULE_BY_ID, RULES } from '../core/rules';
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

function rule(id: string, focus: string | null): HTMLElement {
  const r = RULE_BY_ID.get(id)!;
  return h(
    'li',
    { id: `rule-${r.id}`, class: `rule${r.id === focus ? ' focus' : ''}`, tabindex: '-1' },
    h('div', { class: 'finding-head' }, h('span', { class: `chip chip-${r.severity}` }, r.severity === 'info' ? 'note' : r.severity), h('strong', {}, r.title)),
    h('code', { class: 'rule-id' }, r.id),
    h('p', {}, r.why),
    h('p', { class: 'instead' }, h('span', {}, 'Instead: '), r.instead),
    h('p', { class: 'hint' }, r.source),
  );
}

export function renderRules(focus: string | null): HTMLElement {
  const view = h(
    'div',
    { class: 'rules' },
    h(
      'div',
      { class: 'rules-intro' },
      h('h2', {}, 'From the reviews to the root causes'),
      h(
        'p',
        {},
        `Reviewers, MKBHD first among them, found that iPhone Duo’s rough edges are mostly in third-party apps. Each problem they saw has a cause in how apps are written. duo-ready has ${RULES.length} checks, grouped below by the problem they prevent and traced to Apple’s guidance.`,
      ),
    ),
    PAIN_POINTS.map((p) =>
      h(
        'section',
        { class: 'pain', id: `pain-${p.id}` },
        h(
          'div',
          { class: 'pain-head' },
          h('h3', {}, p.title),
          h('p', {}, h('span', {}, 'Reviewers saw: '), p.seen),
          h('p', {}, h('span', {}, 'Root cause: '), p.cause),
        ),
        h(
          'ol',
          { class: 'rule-list' },
          p.rules.map((id) => rule(id, focus)),
        ),
      ),
    ),
    h(
      'p',
      { class: 'fineprint' },
      'Some complaints are hardware and no app can fix them: the weight, camera quality and battery life. duo-ready covers the part developers control, including apps that assume Face ID or a camera this phone doesn’t have.',
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
