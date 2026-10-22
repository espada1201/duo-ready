import { strToU8, zipSync } from 'fflate';
import { applyFixes, audit, isRelevant, isRelevantDir, MAX_BYTES } from '../core/audit';
import { hunks, type Hunk } from '../core/diff';
import { describeCounts, plural, screensFirst, severityLabel, summaryLine } from '../core/findings';
import { PAIN_POINTS, RULE_BY_ID } from '../core/rules';
import { tierLabel } from '../core/sdk';
import { groupBy } from '../core/text';
import type { AuditResult, Finding, SdkTier, SourceFile } from '../core/types';
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
}

export const initialAudit = (): AuditState => ({ status: 'empty', source: '', files: [], result: null, selected: new Set(), previews: new Map(), error: null, paste: false });

const SAMPLE = import.meta.glob('../../sample/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function sampleFiles(): SourceFile[] {
  return Object.entries(SAMPLE).map(([path, content]) => ({ path: path.replace('../../sample/', ''), content }));
}

function runAudit(files: SourceFile[], source: string): AuditState {
  const relevant = files.filter((f) => isRelevant(f.path));
  if (!relevant.length) {
    return { ...initialAudit(), status: 'error', error: 'No Swift files, Info.plist or Xcode project found there. Pick the folder that contains your .xcodeproj.' };
  }
  const result = audit(relevant);
  const selected = new Set<number>();
  const previews = new Map<number, Hunk[]>();
  const byPath = new Map(relevant.map((f) => [f.path, f]));
  result.findings.forEach((f, i) => {
    if (!f.fix) return;
    if (f.fix.confidence === 'safe') selected.add(i);
    const file = byPath.get(f.path)!;
    previews.set(i, hunks(file.content, applyFixes([file], [f], 'all').files[0].content));
  });
  return { status: 'done', source, files: relevant, result, selected, previews, error: null, paste: false };
}

async function readEntries(entry: FileSystemEntry, prefix: string, out: SourceFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!isRelevant(path)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (file.size <= MAX_BYTES) out.push({ path, content: await file.text() });
  } else if (entry.isDirectory) {
    if (!isRelevantDir(path)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await readEntries(child, path, out);
    }
  }
}

async function filesFromDrop(items: DataTransferItemList): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  for (const e of entries) await readEntries(e, '', out);
  return out;
}

async function filesFromInput(list: FileList): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const f of [...list]) {
    const path = f.webkitRelativePath || f.name;
    if (isRelevant(path) && f.size <= MAX_BYTES) out.push({ path, content: await f.text() });
  }
  return out;
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
    set({ ...state, status: 'loading', error: null });
    try {
      set(runAudit(await get(), source));
    } catch (e) {
      set({ ...initialAudit(), status: 'error', error: `Could not read those files: ${(e as Error).message}` });
    }
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
        const items = (e as DragEvent).dataTransfer?.items;
        if (items) void load(() => filesFromDrop(items), 'Dropped folder');
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
      h('button', { type: 'button', class: 'button', onclick: () => set(runAudit(sampleFiles(), 'Sample app: Encore')) }, 'Try the sample app'),
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
            if (text.trim()) set(runAudit([{ path: 'Pasted.swift', content: text }], 'Pasted code'));
          },
        },
        h('label', { for: 'paste-code' }, 'Swift source'),
        h('textarea', { id: 'paste-code', name: 'code', rows: 8, spellcheck: 'false', placeholder: 'let scale = UIScreen.main.scale' }),
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
  else if (state.status === 'done' && state.result) body = results(state, openPreview);

  return h('div', { class: 'audit' }, intro, h('div', { class: 'audit-input' }, drop, paste), body);
}

function results(state: AuditState, openPreview: (tier: SdkTier | null) => void): HTMLElement {
  const r = state.result!;
  const fixable = r.findings.filter((f) => f.fix).length;
  const label = () => {
    const n = chosenFixes(state).applied.length;
    const skipped = state.selected.size - n;
    return `Download ${n} ${n === 1 ? 'fix' : 'fixes'}${skipped ? ` (${skipped} overlap${skipped === 1 ? 's' : ''} another)` : ''}`;
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
  // Toggling a fix updates in place so keyboard focus stays on the checkbox.
  const toggleFix = (i: number, on: boolean) => {
    if (on) state.selected.add(i);
    else state.selected.delete(i);
    downloadLabel.textContent = label();
    downloadButton.disabled = state.selected.size === 0;
  };

  const summary = h(
    'section',
    { class: 'summary', 'aria-label': 'Audit summary' },
    h('div', { class: 'score', 'data-grade': r.grade }, scoreRing(r.score), h('div', { class: 'score-num' }, h('strong', { 'data-testid': 'score' }, String(r.score)), h('span', {}, '/100'))),
    h(
      'div',
      { class: 'summary-text' },
      h('p', { class: 'eyebrow' }, state.source),
      h('h3', { 'data-testid': 'grade' }, r.grade),
      h('p', {}, summaryLine(r)),
      r.partial
        ? h('p', { class: 'partial', 'data-testid': 'partial' }, 'Partial audit: no Info.plist or Xcode project, so orientation, full-screen and SDK checks did not run. The grade is capped at Close.')
        : null,
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
          const mark = n ? String(n) : unchecked ? 'not checked' : '✓';
          return h('li', { class: n ? 'has' : unchecked ? 'unchecked' : 'none' }, h('a', { href: `#rules/pain-${p.id}` }, p.title), h('strong', {}, mark));
        }),
      ),
      fixable ? h('p', { class: 'hint' }, `${plural(fixable, 'finding')} ${fixable === 1 ? 'has a fix' : 'have fixes'}. Safe ones are pre-selected; review the rest before you tick them.`) : null,
    ),
  );

  const byFile = groupBy(
    r.findings.map((f, i) => [f, i] as [Finding, number]),
    ([f]) => f.path,
  );

  const list = r.findings.length
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

  return h('div', { class: 'results' }, summary, first, h('div', { class: 'file-list', 'data-testid': 'findings' }, list));
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
    h('p', { class: 'instead' }, h('span', {}, 'Instead: '), rule.instead, ' ', h('a', { href: `#rules/${rule.id}` }, 'Source')),
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
