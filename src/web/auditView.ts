import { strToU8, zipSync } from 'fflate';
import { applyFixes, isRelevant, isRelevantDir, MAX_BYTES } from '../core/audit';
import type { Hunk } from '../core/diff';
import { describeCounts, PARTIAL_NOTE, plural, screensFirst, severityLabel, summaryLine, unreadableNote } from '../core/findings';
import { PAIN_POINTS, RULE_BY_ID } from '../core/rules';
import { tierLabel } from '../core/sdk';
import { groupBy } from '../core/text';
import type { AuditResult, Finding, SdkTier, Severity, SourceFile } from '../core/types';
import { analyse, type Analysis } from './analyse';
import { h, svg } from './dom';
import { icon } from './icons';

export interface AuditState {
  status: 'empty' | 'loading' | 'done' | 'error';
  source: string;
  files: SourceFile[];
  result: AuditResult | null;
  /** Indexes into result.findings whose fixes are selected. */
  selected: Set<number>;
  /** The diff each fix makes, by finding index, computed once per audit. */
  previews: Map<number, Hunk[]>;
  error: string | null;
  paste: boolean;
  /** Pasted code not yet audited, kept across tab changes. */
  draft: string;
  /** Which findings the list shows; the summary always counts them all. */
  filter: Filter;
}

interface Filter {
  severity: Severity | null;
  pain: string | null;
  fixable: boolean;
}

const NO_FILTER: Filter = { severity: null, pain: null, fixable: false };

export const initialAudit = (): AuditState => ({ status: 'empty', source: '', files: [], result: null, selected: new Set(), previews: new Map(), error: null, paste: false, draft: '', filter: NO_FILTER });

const SAMPLE = import.meta.glob('../../sample/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function sampleFiles(): SourceFile[] {
  return Object.entries(SAMPLE).map(([path, content]) => ({ path: path.replace('../../sample/', ''), content }));
}

const NOTHING = 'No Swift files, Info.plist or Xcode project found there. Pick the folder that contains your .xcodeproj.';

function stateFrom(files: SourceFile[], { result, previews }: Analysis, source: string): AuditState {
  const selected = new Set(result.findings.flatMap((f, i) => (f.fix?.confidence === 'safe' ? [i] : [])));
  return { status: 'done', source, files, result, selected, previews, error: null, paste: false, draft: '', filter: NO_FILTER };
}

/** For the sample and pasted code, which are small enough to audit in place. */
function runAudit(files: SourceFile[], source: string): AuditState {
  const relevant = files.filter((f) => isRelevant(f.path));
  return relevant.length ? stateFrom(relevant, analyse(relevant), source) : { ...initialAudit(), status: 'error', error: NOTHING };
}

/** Counts audits started, so a slow one that finishes late can't replace a newer one. */
let generation = 0;
let running: Worker | null = null;

/** Audits in a worker so a large project doesn't freeze the page; falls back to the main thread. */
function analyseOffThread(files: SourceFile[]): Promise<Analysis> {
  running?.terminate();
  return new Promise((resolve, reject) => {
    const inPlace = () => {
      try {
        resolve(analyse(files));
      } catch (e) {
        reject(e);
      }
    };
    let worker: Worker;
    try {
      worker = running = new Worker(new URL('./auditWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      inPlace();
      return;
    }
    const done = () => {
      worker.terminate();
      if (running === worker) running = null;
    };
    worker.onmessage = (e: MessageEvent<Analysis>) => {
      done();
      resolve(e.data);
    };
    worker.onerror = worker.onmessageerror = () => {
      done();
      inPlace();
    };
    worker.postMessage(files);
  });
}

// Paths start inside the folder the person picked, as the CLI's do, so a project kept in a
// folder named `build` or `.archive` isn't mistaken for build output.
async function readEntries(entry: FileSystemEntry, prefix: string, out: SourceFile[], picked = false): Promise<void> {
  const path = picked ? '' : prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!isRelevant(path)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (file.size <= MAX_BYTES) out.push({ path, content: await file.text() });
  } else if (entry.isDirectory) {
    if (!picked && !isRelevantDir(path)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      await Promise.all(batch.map((child) => readEntries(child, path, out)));
    }
  }
}

async function filesFromDrop(data: DataTransfer): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  // Without the entries API (or for files a page hands over itself) only loose files can be read.
  if (!entries.length) return filesFromInput(data.files);
  // One dropped folder is the project root; several keep their names so their paths can't collide.
  await Promise.all(entries.map((e) => readEntries(e, '', out, e.isDirectory && entries.length === 1)));
  // Reads finish in any order; sort so findings come out the same on every run.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function filesFromInput(list: FileList): Promise<SourceFile[]> {
  const picked = [...list]
    .map((f) => ({ f, path: f.webkitRelativePath ? f.webkitRelativePath.slice(f.webkitRelativePath.indexOf('/') + 1) : f.name }))
    .filter(({ f, path }) => isRelevant(path) && f.size <= MAX_BYTES);
  return Promise.all(picked.map(async ({ f, path }) => ({ path, content: await f.text() })));
}

function scoreRing(score: number): SVGSVGElement {
  const r = 52;
  const c = 2 * Math.PI * r;
  const circle = (cls: string, dash: string) => svg('circle', { cx: 60, cy: 60, r, class: cls, 'stroke-dasharray': dash });
  return svg('svg', { viewBox: '0 0 120 120', class: 'ring', 'aria-hidden': 'true' }, circle('ring-track', `${c} ${c}`), circle('ring-value', `${(score / 100) * c} ${c}`));
}

function download(name: string, data: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The selected fixes as they would be applied: overlapping fixes are skipped, so this can be fewer than selected. */
function chosenFixes(state: AuditState) {
  return applyFixes(state.files, state.result!.findings.filter((_, i) => state.selected.has(i)), 'all');
}

function fixedZip(state: AuditState): Uint8Array {
  const { files } = chosenFixes(state);
  const entries: Record<string, Uint8Array> = {};
  files.forEach((f, i) => {
    if (f.content !== state.files[i].content) entries[f.path] = strToU8(f.content);
  });
  return zipSync(entries);
}

export function renderAudit(state: AuditState, set: (s: AuditState) => void, openPreview: (tier: SdkTier | null) => void): HTMLElement {
  const load = async (get: () => Promise<SourceFile[]>, source: string) => {
    const mine = ++generation;
    set({ ...state, status: 'loading', error: null });
    let next: AuditState;
    try {
      const relevant = (await get()).filter((f) => isRelevant(f.path));
      next = relevant.length ? stateFrom(relevant, await analyseOffThread(relevant), source) : { ...initialAudit(), status: 'error', error: NOTHING };
    } catch (e) {
      next = { ...initialAudit(), status: 'error', error: `Could not read those files: ${(e as Error).message}` };
    }
    if (mine === generation) set(next);
  };
  // The sample and pasted code finish at once; they still supersede any audit in flight.
  const now = (next: AuditState) => {
    generation++;
    running?.terminate();
    running = null;
    set(next);
  };

  const drop = h(
    'div',
    {
      class: 'dropzone',
      'data-testid': 'dropzone',
      ondragover: (e: Event) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add('over');
      },
      ondragleave: (e: Event) => (e.currentTarget as HTMLElement).classList.remove('over'),
      ondrop: (e: Event) => {
        e.preventDefault();
        const data = (e as DragEvent).dataTransfer;
        if (data) void load(() => filesFromDrop(data), 'Dropped files');
      },
    },
    icon('folder', 28),
    h('p', { class: 'drop-title' }, 'Drop your Xcode project folder here'),
    h('p', { class: 'hint' }, 'Everything runs in this tab. Your code never leaves your Mac.'),
    h(
      'div',
      { class: 'drop-actions' },
      h(
        'label',
        { class: 'button primary' },
        icon('folder', 16),
        h('span', {}, 'Choose folder'),
        h('input', {
          type: 'file',
          webkitdirectory: true,
          multiple: true,
          class: 'visually-hidden',
          'data-testid': 'folder-input',
          onchange: (e: Event) => {
            const list = (e.target as HTMLInputElement).files;
            if (list) void load(() => filesFromInput(list), 'Chosen folder');
          },
        }),
      ),
      h('button', { type: 'button', class: 'button', onclick: () => now(runAudit(sampleFiles(), 'Sample app: Encore')) }, 'Try the sample app'),
      h('button', { type: 'button', class: 'button ghost', onclick: () => set({ ...state, paste: !state.paste }), 'aria-expanded': String(state.paste) }, 'Paste Swift'),
    ),
  );

  const paste = state.paste
    ? h(
        'form',
        {
          class: 'paste',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const text = ((e.currentTarget as HTMLFormElement).elements.namedItem('code') as HTMLTextAreaElement).value;
            if (text.trim()) now(runAudit([{ path: 'Pasted.swift', content: text }], 'Pasted code'));
          },
        },
        h('label', { for: 'paste-code' }, 'Swift source'),
        h(
          'textarea',
          {
            id: 'paste-code',
            name: 'code',
            rows: 8,
            spellcheck: 'false',
            required: true,
            placeholder: 'let scale = UIScreen.main.scale',
            oninput: (e: Event) => (state.draft = (e.target as HTMLTextAreaElement).value),
          },
          state.draft,
        ),
        h('button', { type: 'submit', class: 'button primary' }, 'Audit'),
      )
    : null;

  const intro = h(
    'div',
    { class: 'audit-intro' },
    h('h2', {}, 'Audit your app'),
    h('p', {}, 'duo-ready reads your Swift, Info.plist and Xcode project, finds what breaks on iPhone Duo, and rewrites what it safely can.'),
  );

  let body: HTMLElement | null = null;
  if (state.status === 'loading') body = h('p', { class: 'status-line', role: 'status' }, 'Reading files…');
  else if (state.status === 'error') body = h('p', { class: 'error', role: 'alert' }, state.error);
  else if (state.status === 'done' && state.result) body = results(state, set, openPreview);

  return h('div', { class: 'audit' }, intro, h('div', { class: 'audit-input' }, drop, paste), body);
}

function results(state: AuditState, set: (s: AuditState) => void, openPreview: (tier: SdkTier | null) => void): HTMLElement {
  const r = state.result!;
  const fixable = r.findings.filter((f) => f.fix).length;
  const { severity, pain, fixable: onlyFixable } = state.filter;
  const painRules = pain ? PAIN_POINTS.find((p) => p.id === pain)!.rules : null;
  const shown = r.findings
    .map((f, i) => [f, i] as [Finding, number])
    .filter(([f]) => (!severity || f.severity === severity) && (!painRules || painRules.includes(f.ruleId)) && (!onlyFixable || f.fix));
  const visible = new Set(shown.map(([, i]) => i));
  const label = () => {
    const n = chosenFixes(state).applied.length;
    const skipped = state.selected.size - n;
    const hidden = [...state.selected].filter((i) => !visible.has(i)).length;
    const notes = [skipped ? `${skipped} overlap${skipped === 1 ? 's' : ''} another` : '', hidden ? `${hidden} hidden by the filter` : ''].filter(Boolean);
    return `Download ${n} ${n === 1 ? 'fix' : 'fixes'}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  };
  const downloadLabel = h('span', {}, label());
  const downloadButton = h(
    'button',
    {
      type: 'button',
      class: 'button primary',
      disabled: state.selected.size === 0,
      'data-testid': 'download',
      onclick: () => download('duo-ready-fixes.zip', fixedZip(state), 'application/zip'),
    },
    icon('download', 16),
    downloadLabel,
  );
  const filterBy = (patch: Partial<Filter>) => set({ ...state, filter: { ...state.filter, ...patch } });
  // Toggling a fix updates in place so keyboard focus stays on the checkbox.
  const toggleFix = (i: number, on: boolean) => {
    if (on) state.selected.add(i);
    else state.selected.delete(i);
    downloadLabel.textContent = label();
    downloadButton.disabled = state.selected.size === 0;
  };

  const summary = h(
    'section',
    { class: 'summary', id: 'audit-summary', tabindex: '-1', 'aria-label': 'Audit summary' },
    h('div', { class: 'score', 'data-grade': r.grade }, scoreRing(r.score), h('div', { class: 'score-num' }, h('strong', { 'data-testid': 'score' }, String(r.score)), h('span', {}, '/100'))),
    h(
      'div',
      { class: 'summary-text' },
      h('p', { class: 'eyebrow' }, state.source),
      h('h3', { 'data-testid': 'grade' }, r.grade),
      h('p', {}, summaryLine(r)),
      r.partial ? h('p', { class: 'partial', 'data-testid': 'partial' }, PARTIAL_NOTE) : null,
      r.unreadable.length ? h('p', { class: 'partial', 'data-testid': 'unreadable' }, unreadableNote(r.unreadable)) : null,
      r.tier ? h('p', {}, `Today Duo users likely see ${tierLabel(r.tier.value)}. `, h('span', { class: 'hint' }, `Based on ${r.tier.source}.`)) : null,
      h(
        'div',
        { class: 'summary-actions' },
        downloadButton,
        h('button', { type: 'button', class: 'button', onclick: () => openPreview(r.tier?.value ?? null) }, 'Preview on Duo', icon('arrow', 16)),
      ),
      h(
        'ul',
        { class: 'pain-chips', 'aria-label': 'Findings by reviewer pain point' },
        PAIN_POINTS.map((p) => {
          const n = r.findings.filter((f) => p.rules.includes(f.ruleId)).length;
          const unchecked = !n && r.partial && p.rules.some((id) => RULE_BY_ID.get(id)!.project);
          const on = state.filter.pain === p.id;
          const mark = n
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'count',
                  'data-key': `pain-${p.id}`,
                  'aria-pressed': String(on),
                  'aria-label': `Show only the ${n} ${p.title.toLowerCase()} findings`,
                  onclick: () => filterBy({ pain: on ? null : p.id }),
                },
                String(n),
              )
            : unchecked
              ? 'not checked'
              : h('span', { 'aria-label': 'none' }, '✓');
          return h('li', { class: n ? 'has' : unchecked ? 'unchecked' : 'none' }, h('a', { href: `#rules/pain-${p.id}` }, p.title), n ? mark : h('strong', {}, mark));
        }),
      ),
      fixable ? h('p', { class: 'hint' }, fixHint(fixable, r.findings.filter((f) => f.fix?.confidence === 'safe').length)) : null,
    ),
  );

  const byFile = groupBy(shown, ([f]) => f.path);

  const severities: [Severity | null, string][] = [
    [null, `All ${r.findings.length}`],
    ...(['error', 'warning', 'info'] as const).map((sev): [Severity, string] => [sev, `${plural(r.findings.filter((f) => f.severity === sev).length, severityLabel(sev))}`]),
  ];
  const filters = r.findings.length
    ? h(
        'div',
        { class: 'filters', role: 'group', 'aria-label': 'Filter findings' },
        severities.map(([sev, text]) =>
          h(
            'button',
            { type: 'button', class: 'button ghost', 'data-key': `severity-${sev ?? 'all'}`, 'aria-pressed': String(severity === sev), onclick: () => filterBy({ severity: sev }) },
            text,
          ),
        ),
        fixable
          ? h(
              'label',
              { class: 'fix-only' },
              h('input', { type: 'checkbox', name: 'fixable-only', checked: onlyFixable, onchange: (e: Event) => filterBy({ fixable: (e.target as HTMLInputElement).checked }) }),
              ' Only findings with a fix',
            )
          : null,
        shown.length < r.findings.length
          ? h('p', { class: 'hint', 'data-testid': 'filter-count' }, `Showing ${shown.length} of ${r.findings.length}. `, h('button', { type: 'button', class: 'link', 'data-key': 'severity-all', onclick: () => filterBy(NO_FILTER) }, 'Show all'))
          : null,
      )
    : null;

  const list = shown.length
    ? [...byFile].map(([path, items]) =>
        h(
          'section',
          { class: 'file' },
          h('h4', {}, icon('doc', 16), h('span', {}, h('span', { class: 'dir' }, path.slice(0, path.lastIndexOf('/') + 1)), path.slice(path.lastIndexOf('/') + 1))),
          h(
            'ol',
            { class: 'findings' },
            items.map(([f, i]) => finding(state, f, i, toggleFix)),
          ),
        ),
      )
    : r.findings.length
      ? [h('p', { class: 'hint' }, 'No findings match this filter.')]
      : [h('p', { class: 'all-clear' }, icon('check', 16), ' No problems found. Build with Xcode 27.1 and check every pose in the simulator.')];

  const screens = screensFirst(r.findings).slice(0, 3);
  const first = screens.length
    ? h(
        'section',
        { class: 'screens-first', 'aria-label': 'Fix these screens first', 'data-testid': 'screens' },
        h('h3', {}, 'Fix these screens first'),
        h(
          'ol',
          {},
          screens.map((s) => h('li', {}, h('strong', {}, s.screen), ' ', h('span', { class: 'hint' }, `${describeCounts(s.findings)} · ${s.path}`))),
        ),
      )
    : null;

  return h(
    'div',
    { class: 'results' },
    summary,
    first,
    h('div', { class: 'file-list', 'data-testid': 'findings' }, r.findings.length ? h('h3', {}, 'Findings by file') : null, filters, list),
  );
}

function fixHint(fixable: number, safe: number): string {
  const have = `${plural(fixable, 'finding')} ${fixable === 1 ? 'has a fix' : 'have fixes'}.`;
  if (safe === fixable) return `${have} ${fixable === 1 ? 'It is safe and pre-selected' : 'All are safe and pre-selected'}.`;
  if (safe === 0) return `${have} None are safe to apply blind; review each one before you tick it.`;
  return `${have} The ${safe} safe ${safe === 1 ? 'one is' : 'ones are'} pre-selected; review the rest before you tick them.`;
}

function finding(state: AuditState, f: Finding, i: number, toggleFix: (i: number, on: boolean) => void): HTMLElement {
  const rule = RULE_BY_ID.get(f.ruleId)!;
  const preview = state.previews.get(i);
  return h(
    'li',
    { class: `finding sev-${f.severity}`, 'data-rule': f.ruleId },
    h(
      'div',
      { class: 'finding-head' },
      h('span', { class: `chip chip-${f.severity}` }, severityLabel(f.severity)),
      h('strong', {}, rule.title),
      h('span', { class: 'loc' }, f.screen ? `${f.screen}, line ${f.line}` : `line ${f.line}`),
    ),
    h('pre', { class: 'excerpt' }, h('code', {}, f.excerpt)),
    h('p', {}, f.message),
    h('p', { class: 'instead' }, h('span', {}, 'Instead: '), rule.instead, ' ', h('a', { href: `#rules/${rule.id}`, 'aria-label': `Why: ${rule.title}` }, 'Why')),
    preview && f.fix
      ? h(
          'div',
          { class: 'fix' },
          h(
            'label',
            { class: 'fix-toggle' },
            h('input', { type: 'checkbox', checked: state.selected.has(i), onchange: (e: Event) => toggleFix(i, (e.target as HTMLInputElement).checked) }),
            h('span', {}, f.fix.description, ' ', h('em', {}, f.fix.confidence === 'safe' ? 'Safe' : 'Review first')),
          ),
          h(
            'pre',
            { class: 'diff' },
            preview.flatMap((hunk) => [
              ...hunk.removed.map((l) => h('span', { class: 'del' }, `- ${l}\n`)),
              ...hunk.added.map((l) => h('span', { class: 'add' }, `+ ${l}\n`)),
            ]),
          ),
        )
      : null,
  );
}
