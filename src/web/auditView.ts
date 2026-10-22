import { strToU8, zipSync } from 'fflate';
import { applyFixes, audit, isRelevant } from '../core/audit';
import { PAIN_POINTS } from '../core/painPoints';
import { RULE_BY_ID, tierLabel } from '../core/rules';
import type { AuditResult, Finding, SourceFile } from '../core/types';
import { h } from './dom';
import { icon } from './icons';

export interface AuditState {
  status: 'empty' | 'loading' | 'done' | 'error';
  source: string;
  files: SourceFile[];
  result: AuditResult | null;
  /** Indexes into result.findings whose fixes are selected. */
  selected: Set<number>;
  error: string | null;
  paste: boolean;
}

export const initialAudit = (): AuditState => ({ status: 'empty', source: '', files: [], result: null, selected: new Set(), error: null, paste: false });

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
  result.findings.forEach((f, i) => f.fix?.confidence === 'safe' && selected.add(i));
  return { status: 'done', source, files: relevant, result, selected, error: null, paste: false };
}

const MAX_BYTES = 2_000_000;

async function readEntries(entry: FileSystemEntry, prefix: string, out: SourceFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!isRelevant(path)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (file.size <= MAX_BYTES) out.push({ path, content: await file.text() });
  } else if (entry.isDirectory) {
    if (!isRelevant(`${path}/x.swift`)) return;
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

/** The changed lines a single fix produces, for the inline diff. */
function fixPreview(file: SourceFile, finding: Finding): { before: string[]; after: string[] } {
  const { files } = applyFixes([file], [finding], 'all');
  const a = file.content.split('\n');
  const b = files[0].content.split('\n');
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { before: a.slice(start, endA + 1), after: b.slice(start, endB + 1) };
}

function scoreRing(score: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const r = 52;
  const c = 2 * Math.PI * r;
  for (const [cls, dash] of [
    ['ring-track', `${c} ${c}`],
    ['ring-value', `${(score / 100) * c} ${c}`],
  ]) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '60');
    circle.setAttribute('cy', '60');
    circle.setAttribute('r', String(r));
    circle.setAttribute('class', cls);
    circle.setAttribute('stroke-dasharray', dash);
    svg.appendChild(circle);
  }
  return svg;
}

function download(name: string, data: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fixedZip(state: AuditState): Uint8Array {
  const chosen = state.result!.findings.filter((_, i) => state.selected.has(i));
  const { files } = applyFixes(state.files, chosen, 'all');
  const entries: Record<string, Uint8Array> = {};
  files.forEach((f, i) => {
    if (f.content !== state.files[i].content) entries[f.path] = strToU8(f.content);
  });
  return zipSync(entries);
}

export function renderAudit(state: AuditState, set: (s: AuditState) => void, openPreview: (tier: string | null) => void): HTMLElement {
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

function results(state: AuditState, openPreview: (tier: string | null) => void): HTMLElement {
  const r = state.result!;
  const count = (s: Finding['severity']) => r.findings.filter((f) => f.severity === s).length;
  const fixable = r.findings.map((f, i) => [f, i] as const).filter(([f]) => f.fix);
  const label = () => `Download ${state.selected.size} fix${state.selected.size === 1 ? '' : 'es'}`;
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
      h('p', {}, `${r.files} files (${r.swiftFiles} Swift) · ${count('error')} errors · ${count('warning')} warnings · ${count('info')} notes`),
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
          return h('li', { class: n ? 'has' : 'none' }, h('a', { href: `#rules/${p.rules[0]}` }, p.title), h('strong', {}, n ? String(n) : '✓'));
        }),
      ),
      fixable.length ? h('p', { class: 'hint' }, `${fixable.length} findings have fixes. Safe ones are pre-selected; review the rest before you tick them.`) : null,
    ),
  );

  const byFile = new Map<string, [Finding, number][]>();
  r.findings.forEach((f, i) => byFile.set(f.path, [...(byFile.get(f.path) ?? []), [f, i]]));

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

  return h('div', { class: 'results' }, summary, h('div', { class: 'file-list', 'data-testid': 'findings' }, list));
}

function finding(state: AuditState, f: Finding, i: number, toggleFix: (i: number, on: boolean) => void): HTMLElement {
  const rule = RULE_BY_ID.get(f.ruleId)!;
  const file = state.files.find((x) => x.path === f.path)!;
  const preview = f.fix ? fixPreview(file, f) : null;
  return h(
    'li',
    { class: `finding sev-${f.severity}`, 'data-rule': f.ruleId },
    h(
      'div',
      { class: 'finding-head' },
      h('span', { class: `chip chip-${f.severity}` }, f.severity === 'info' ? 'note' : f.severity),
      h('strong', {}, rule.title),
      h('span', { class: 'loc' }, `line ${f.line}`),
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
            preview.before.map((l) => h('span', { class: 'del' }, `- ${l.trim()}\n`)),
            preview.after.map((l) => h('span', { class: 'add' }, `+ ${l.trim()}\n`)),
          ),
        )
      : null,
  );
}
