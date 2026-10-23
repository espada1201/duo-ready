import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { applyFixes, audit, isRelevant, isRelevantDir, MAX_BYTES, otherPlatform } from '../core/audit';
import { patchFor } from '../core/diff';
import { describeCounts, fixCounts, fixLabel, gainLabel, GRADE_LEGEND, objcNote, PARTIAL_NOTE, plural, SCREENS_NOTE, screensFirst, SEVERITY_ORDER, severityLabel, summaryLine, tierNote, unreadableNote } from '../core/findings';
import { PAIN_POINTS, RULE_BY_ID } from '../core/rules';
import { groupBy } from '../core/text';
import type { AuditResult, SourceFile } from '../core/types';
import { toSarif } from './sarif';

declare const __VERSION__: string;

const HELP = `duo-ready: audit an iPhone app for iPhone Duo and fix what can be fixed.

Usage
  duo-ready [path]                 Audit the project at path (default: .)
  duo-ready [path] --fix           Apply safe fixes in place
  duo-ready [path] --fix all       Also apply review fixes, which need a human look
  duo-ready [path] --dry-run       Show what --fix would change as a patch, write nothing
  duo-ready rules                  List every rule and the Apple guidance behind it

From the duo-ready folder, run it as \`npm run -s audit -- ../MyApp\`. Without a clone,
\`npx github:espada1201/duo-ready ../MyApp\` works too. Paths are relative to the folder
you ran the command in.

Options
  --format text|json|sarif         Output format (default: text)
  --out <file>                     Write the report to a file. With --dry-run, write the
                                   patch instead, so git apply <file> works. With
                                   --dry-run and --format json or sarif, the file still
                                   gets the report and the patch goes to stderr.
  --fail-on error|warning|note|info|never
                                   Exit 1 at this severity or worse (default: error).
                                   info is the same as note; JSON and SARIF say info.
  --no-color                       Plain output

Exit codes
  0  nothing at or above --fail-on
  1  findings at or above --fail-on
  2  bad arguments, or a project that can't be read or written
`;

interface AuditOptions {
  kind: 'audit';
  path: string;
  fix: 'safe' | 'all' | null;
  dryRun: boolean;
  format: 'text' | 'json' | 'sarif';
  out: string | null;
  failOn: 'error' | 'warning' | 'note' | 'never';
  color: boolean;
}

type Command = AuditOptions | { kind: 'help' } | { kind: 'rules' } | { kind: 'error'; message: string };

const oneOf = <T extends string>(flag: string, v: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${flag} takes ${allowed.map((a) => `"${a}"`).join(', ').replace(/, ([^,]*)$/, ' or $1')}, not "${v}"`);
  return v as T;
};

function parseArgs(argv: string[], base: string): Command {
  const o: AuditOptions = { kind: 'audit', path: '.', fix: null, dryRun: false, format: 'text', out: null, failOn: 'error', color: !process.env.NO_COLOR && !!process.stdout.isTTY };
  let rules = false;
  let path: string | null = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const value = () => {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`${flag} needs a value`);
        return v;
      };
      if (a === '-h' || a === '--help') return { kind: 'help' };
      else if (flag === '--fix') {
        // `--fix`, `--fix=all` and `--fix all` all work; a bare `--fix` means safe fixes only.
        const next = argv[i + 1];
        if (inline === undefined && next && !['all', 'safe'].includes(next) && !next.startsWith('-') && !existsSync(userPath(next, base)))
          throw new Error(`--fix takes "safe" or "all", and "${next}" isn't a folder either`);
        const level = inline ?? (next === 'all' || next === 'safe' ? argv[++i] : 'safe');
        o.fix = oneOf('--fix', level, ['safe', 'all'] as const);
      } else if (a === '--dry-run') o.dryRun = true;
      else if (a === '--no-color') o.color = false;
      else if (flag === '--format') o.format = oneOf('--format', value(), ['text', 'json', 'sarif'] as const);
      else if (flag === '--out') o.out = value();
      else if (flag === '--fail-on') {
        const level = oneOf('--fail-on', value(), ['error', 'warning', 'note', 'info', 'never'] as const);
        o.failOn = level === 'info' ? 'note' : level;
      }
      else if (a.startsWith('-')) return { kind: 'error', message: `Unknown option ${a}` };
      // `rules` is the subcommand unless there is a folder of that name to audit.
      else if (a === 'rules' && !existsSync(userPath(a, base))) rules = true;
      else if (path !== null) return { kind: 'error', message: `One project at a time: got "${path}" and "${a}". If the folder name has a space, put the path in quotes.` };
      else path = a;
    }
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
  return rules ? { kind: 'rules' } : { ...o, path: path ?? '.' };
}

function readProject(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      // lstat: symlinked folders are skipped, so link cycles can't recurse forever.
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      const rel = relative(root, full).split('\\').join('/');
      if (st.isDirectory()) {
        if (isRelevantDir(rel)) visit(full);
      } else if (st.size <= MAX_BYTES && isRelevant(rel)) out.push({ path: rel, content: readFileSync(full, 'utf8') });
    }
  };
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st) throw new Error(`No such file or folder: ${root}`);
  if (st.isDirectory()) visit(root);
  else if (isRelevant(root)) out.push({ path: root.split('/').pop()!, content: readFileSync(root, 'utf8') });
  return out;
}

/** Paths of the files in the top two levels of a folder, enough to recognise another platform's project. */
function topNames(root: string, depth = 2): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (depth > 1 && isRelevantDir(e.name) ? topNames(join(root, e.name), depth - 1).map((p) => `${e.name}/${p}`) : []) : [e.name],
  );
}

function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap('31'), yellow: wrap('33'), cyan: wrap('36'), dim: wrap('2'), bold: wrap('1'), green: wrap('32') };
}

function textReport(result: AuditResult, c: ReturnType<typeof paint>): string {
  // The verdict leads too, so a long report doesn't hide it above the fold of a short terminal.
  const lines: string[] = result.findings.length ? [`${c.bold(`Duo readiness ${result.score}/100`)}  ${result.grade}. Details below, summary at the end.`, ''] : [];
  const mark = { error: c.red('error  '), warning: c.yellow('warning'), info: c.cyan('note   ') };
  const indent = ' '.repeat(18);
  // A rule's advice is printed under its first finding only, so a rule that fires 20 times doesn't repeat it.
  const advised = new Set<string>();
  for (const [path, findings] of [...groupBy(result.findings, (f) => f.path)].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(c.bold(path));
    for (const f of findings.sort((a, b) => a.line - b.line)) {
      const rule = RULE_BY_ID.get(f.ruleId)!;
      lines.push(`  ${c.dim(`${f.line}:${f.column}`.padEnd(7))} ${mark[f.severity]}  ${rule.title}${c.green(fixLabel(f))}`);
      lines.push(`${indent}${c.dim(f.excerpt)}`);
      lines.push(`${indent}${f.message}`);
      if (!advised.has(rule.id)) lines.push(`${indent}${c.dim(`Instead: ${rule.instead}`)}`);
      advised.add(rule.id);
    }
    lines.push('');
  }

  const screens = screensFirst(result.findings).slice(0, 3);
  if (screens.length) {
    lines.push(c.bold('Fix these first'));
    const width = Math.max(...screens.map((s) => s.screen.length));
    const gainWidth = Math.max(...screens.map((s) => gainLabel(s).length));
    for (const s of screens) lines.push(`  ${s.screen.padEnd(width)}  ${gainLabel(s).padEnd(gainWidth)}  ${describeCounts(s.findings)}  ${c.dim(s.path)}`);
    lines.push(c.dim(`  ${SCREENS_NOTE}`));
    lines.push('');
  }

  const { safe, review } = fixCounts(result.findings);
  lines.push(`${c.bold(`Duo readiness ${result.score}/100`)}  ${result.grade}  ${c.dim(GRADE_LEGEND)}`);
  lines.push(summaryLine(result));
  if (result.partial) lines.push(c.yellow(PARTIAL_NOTE));
  if (result.unreadable.length) lines.push(c.yellow(unreadableNote(result.unreadable)));
  if (result.objcFiles) lines.push(c.yellow(objcNote(result.objcFiles)));
  if (result.tier) lines.push(`${tierNote(result.tier)} (based on ${result.tier.source}).`);
  if (safe || review) lines.push(`${plural(safe, 'safe fix', 'safe fixes')} (--fix), ${plural(review, 'review fix', 'review fixes')} (--fix all). Try --dry-run first.`);
  return lines.join('\n');
}

/**
 * Runs the CLI. The report goes to `log` (stdout). Status lines go to `err` (stderr)
 * whenever stdout carries JSON or SARIF, so a piped report stays valid.
 */
export function run(argv: string[], log = (s: string) => console.log(s), err = (s: string) => console.error(s)): number {
  const base = startDir();
  const cmd = parseArgs(argv, base);
  if (cmd.kind === 'help') {
    log(HELP);
    return 0;
  }
  if (cmd.kind === 'rules') {
    for (const g of PAIN_POINTS) {
      log(`${g.title}\n${'='.repeat(g.title.length)}\n`);
      for (const r of g.rules.map((id) => RULE_BY_ID.get(id)!))
        log(`${r.id.padEnd(26)} ${severityLabel(r.severity).padEnd(8)} ${r.title}\n${' '.repeat(36)}${r.instead}\n${' '.repeat(36)}${r.source}\n`);
    }
    return 0;
  }
  if (cmd.kind === 'error') {
    err(`${cmd.message}\n\n${HELP}`);
    return 2;
  }
  const status = cmd.format === 'text' ? log : err;
  const root = userPath(cmd.path, base);
  let files: SourceFile[];
  try {
    files = readProject(root);
  } catch (e) {
    err(`${(e as Error).message}\nPaths are relative to the folder you ran the command in (${base}).`);
    return 2;
  }
  const c = paint(cmd.color);
  // A 1 after a fix or a dry run that worked reads as a failure, so the last line says what it means.
  // It goes to stderr in every format: stdout may be a patch or a report that someone redirects to a file.
  const finish = (r: AuditResult) => {
    const code = exitCode(r, cmd.failOn);
    if (code === 1 && cmd.failOn !== 'never') err(c.dim(`Exit code 1 means findings at ${cmd.failOn} or worse remain, not that this run failed. --fail-on never exits 0.`));
    return code;
  };
  if (files.length === 0) {
    const kind = otherPlatform(topNames(root));
    err(
      `No Swift, Objective-C, Info.plist or Xcode project files found in ${root}.` +
        (kind ? ` It looks like ${kind}, and duo-ready only checks iPhone apps.` : '') +
        ` Point duo-ready at the folder that holds your .xcodeproj.`,
    );
    return 2;
  }
  let result = audit(files);
  let after = '';

  if (cmd.fix || cmd.dryRun) {
    const { files: fixed, applied } = applyFixes(files, result.findings, cmd.fix ?? 'safe');
    // Review fixes wait for --fix all.
    const held = cmd.fix === 'all' ? 0 : result.findings.filter((f) => f.fix?.confidence === 'review').length;
    const none = held
      ? `No safe fixes. ${plural(held, 'review fix', 'review fixes')} ${held === 1 ? 'needs' : 'need'} a human look: --dry-run --fix all shows ${held === 1 ? 'it' : 'them'}.`
      : 'Nothing to fix.';
    if (cmd.dryRun) {
      const diff = patchFor(files, applied);
      // As text, --out takes the patch, so the file is something git apply accepts. With json or
      // sarif it still takes the report and the diff goes to stderr, so stdout stays a valid report.
      if (cmd.out && cmd.format === 'text') {
        if (!diff) {
          status(`${none} No patch file written.`);
          return finish(result);
        }
        const file = userPath(cmd.out, base);
        try {
          writeFileSync(file, diff + '\n');
        } catch (e) {
          err(`Could not write the patch: ${(e as Error).message}`);
          return 2;
        }
        status(`Patch written to ${file}. ${plural(applied.length, 'fix', 'fixes')} would be applied. Nothing else was written. To apply later, run git apply ${file} in ${baseDir(root)}.`);
        return finish(result);
      }
      status(diff || none);
      if (diff) {
        const save = cmd.format === 'text' ? '--out duo.patch' : '2> duo.patch';
        status(c.dim(`\n${plural(applied.length, 'fix', 'fixes')} would be applied. Nothing was written. To apply later, save this with ${save} and run git apply duo.patch in ${baseDir(root)}.`));
      }
      if (cmd.format === 'text') return finish(result);
    } else {
      const base = baseDir(root);
      const changed = fixed.filter((file, i) => file.content !== files[i].content).map((file) => file.path);
      try {
        for (const file of fixed) if (changed.includes(file.path)) writeFileSync(join(base, file.path), file.content);
      } catch (e) {
        err(`Could not write fixes: ${(e as Error).message}`);
        return 2;
      }
      const done = applied.length ? c.green(`Applied ${plural(applied.length, 'fix', 'fixes')} to ${changed.join(', ')}.`) : none;
      status(done);
      // Repeated after the report, where the eye lands when the command finishes.
      after = changed.length ? `\n${done}\n${c.dim('Review them with git diff before you commit; git checkout -- <file> undoes one.')}` : `\n${done}`;
      result = audit(fixed);
    }
  }

  const render: Record<AuditOptions['format'], () => string> = {
    json: () => JSON.stringify({ ...result, rules: Object.fromEntries([...new Set(result.findings.map((f) => f.ruleId))].map((id) => [id, ruleHelp(id)])) }, null, 2),
    sarif: () => JSON.stringify(toSarif(result, __VERSION__, repoPrefix(root)), null, 2),
    text: () => textReport(result, cmd.out ? paint(false) : c),
  };
  const body = render[cmd.format]();
  if (cmd.out) {
    try {
      writeFileSync(userPath(cmd.out, base), body + '\n');
    } catch (e) {
      err(`Could not write the report: ${(e as Error).message}`);
      return 2;
    }
    status(`Report written to ${userPath(cmd.out, base)}`);
  } else log(body);
  if (after) status(after);

  return finish(result);
}

const FAIL_AT = { error: 0, warning: 1, note: 2 } as const;

function exitCode(result: AuditResult, failOn: AuditOptions['failOn']): number {
  if (failOn === 'never') return 0;
  return result.findings.some((f) => SEVERITY_ORDER[f.severity] <= FAIL_AT[failOn]) ? 1 : 0;
}

/** The real location of a path, through symlinks; the path itself when it can't be resolved. */
const canonical = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * Where relative paths start: the folder the person ran the command in. `npm run` moves to the
 * package root and keeps that folder in INIT_CWD, but a script that cds elsewhere inherits a stale one.
 * The two package folders are compared as real paths (macOS keeps /tmp and /var behind symlinks),
 * and without regard to letter case where the file system ignores it.
 */
export function startDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform: string = process.platform): string {
  const { INIT_CWD, npm_package_json } = env;
  if (!INIT_CWD || !npm_package_json) return cwd;
  const norm = (p: string) => (platform === 'darwin' || platform === 'win32' ? canonical(p).toLowerCase() : canonical(p));
  return norm(dirname(npm_package_json)) === norm(cwd) ? INIT_CWD : cwd;
}

/** A path as the person typed it: `~` is their home folder (a shell only expands it unquoted), the rest starts from `base`. */
function userPath(path: string, base: string): string {
  return (path === '~' || path.startsWith('~/')) && !existsSync(resolve(base, path)) ? join(homedir(), path.slice(1)) : resolve(base, path);
}

function ruleHelp(id: string) {
  const { title, why, instead, source } = RULE_BY_ID.get(id)!;
  return { title, why, instead, source };
}

/** The folder that relative paths in the report start from. */
const baseDir = (root: string) => (statSync(root).isDirectory() ? root : dirname(root));

/** Path from the enclosing git checkout to the audited folder, so SARIF paths match the repo. */
function repoPrefix(root: string): string {
  // Through symlinks, so the prefix matches where git sees the folder.
  const start = canonical(baseDir(root));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return relative(dir, start).split('\\').join('/');
    if (dirname(dir) === dir) return '';
  }
}
