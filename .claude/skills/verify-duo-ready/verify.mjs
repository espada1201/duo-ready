#!/usr/bin/env node
// Drives the real Duo Lab and CLI the way a developer would, and keeps the evidence.
// Usage: node .claude/skills/verify-duo-ready/verify.mjs [doctor | all | <feature>...]
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const ROOT = resolve(import.meta.dirname, '../../..');
const PORT = Number(process.env.PORT ?? 4190);
const URL = `http://127.0.0.1:${PORT}/`;
const EVIDENCE = process.env.EVIDENCE_DIR ?? join(tmpdir(), 'duo-ready-verify', new Date().toISOString().replace(/[:.]/g, '-'));
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const assert = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
};

function cli(args, cwd = ROOT) {
  const r = spawnSync('node', [join(ROOT, 'dist-cli/duo-ready.js'), ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function proof(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  writeFileSync(join(dir, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
}

/** Waits for the audit to render, then counts its findings. */
async function findings(page) {
  await page.locator('.finding, [role=alert]').first().waitFor();
  return page.locator('.finding').count();
}

const choose = (page, name) => page.getByRole('radio', { name, exact: true }).check();
const text = (page, id) => page.getByTestId(id).innerText();

const FEATURES = {
  async preview(page, dir) {
    await page.goto(URL);
    assert((await text(page, 'window')) === '430 × 626 pt, 48% of the display', 'old SDK app sits in an iPhone-sized window');
    await choose(page, 'Half folded, book');
    assert((await text(page, 'problems')).includes('The hinge cuts through'), 'hinge collision reported when half folded');
    await choose(page, 'iOS 27.1 SDK');
    assert((await page.locator('.overlay-collision').count()) > 0, 'collisions drawn for unchanged code');
    await choose(page, '27.1 + recommended changes');
    assert((await text(page, 'problems')).includes('No collisions'), 'recommended build clears hinge, camera and status bar');
    assert((await text(page, 'changes')).includes('NavigationView becomes NavigationStack'), 'change list names what duo-ready applies');
    await proof(page, dir, 'ready-book');
  },

  async 'fold-test'(page, dir) {
    await page.goto(URL);
    await choose(page, 'iOS 27.1 SDK');
    await choose(page, 'Closed');
    await choose(page, 'Open');
    assert((await text(page, 'continuity')).includes('Lost: your scroll position in the album list'), 'unchanged build loses its place on unfold');
    await proof(page, dir, 'lost');
    await choose(page, '27.1 + recommended changes');
    await choose(page, 'Closed');
    assert((await text(page, 'continuity')).includes('the views didn’t'), 'recommended build keeps its place');
    await proof(page, dir, 'kept');
  },

  async 'split-view'(page, dir) {
    await page.goto(URL);
    await choose(page, 'iOS 27.1 SDK');
    await choose(page, 'Split View');
    assert((await text(page, 'window')) === '445 × 626 pt, 100% of its half of the display', 'app gets half the inner display');
    assert(await page.locator('.other-app').isVisible(), 'the other app is drawn');
    await proof(page, dir, 'split');
  },

  async 'audit-sample'(page, dir) {
    await page.goto(`${URL}#audit`);
    await page.getByRole('button', { name: 'Try the sample app' }).click();
    assert((await findings(page)) === 31, 'sample app shows 31 findings');
    assert((await text(page, 'screens')).includes('PlayerViewController'), 'worst screen is listed first');
    await page.locator('.finding[data-rule="tab-sidebar"] input[type=checkbox]').check();
    assert((await text(page, 'download')) === 'Download 3 fixes', 'download counts the selected fixes');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
    const zipPath = join(dir, 'fixes.zip');
    mkdirSync(dir, { recursive: true });
    await download.saveAs(zipPath);
    const zip = unzipSync(new Uint8Array(readFileSync(zipPath)));
    assert(strFromU8(zip['Encore/Encore/LibraryView.swift']).includes('.defaultTabBarPlacement(.sidebar)'), 'zip holds the fixed Swift');
    await proof(page, dir, 'results');
    await page.getByRole('button', { name: '8 errors' }).click();
    assert((await findings(page)) === 8 && (await page.locator('.finding.sev-error').count()) === 8, 'severity filter shows only errors');
    assert((await text(page, 'download')).startsWith('Download 3 fixes ('), 'download notes fixes hidden by the filter');
    await proof(page, dir, 'filtered');
    await page.getByRole('button', { name: 'Show all' }).click();
    await page.getByRole('link', { name: 'Breaks when you fold or unfold' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'pain-fold');
    assert(page.url().endsWith('#rules/pain-fold'), 'pain chip opens its section');
  },

  async 'audit-paste'(page, dir) {
    await page.goto(`${URL}#audit`);
    await page.getByRole('button', { name: 'Paste Swift' }).click();
    await page.getByLabel('Swift source').fill('final class A: UIViewController {\n  func f() { let s = UIScreen.main.scale }\n}');
    await page.getByRole('button', { name: 'Audit', exact: true }).click();
    assert((await page.locator('.diff').innerText()).includes('traitCollection.displayScale'), 'fix preview shows the rewrite');
    assert(await page.getByTestId('partial').isVisible(), 'pasted code is marked a partial audit');
    await proof(page, dir, 'paste');
  },

  async 'audit-folder'(page, dir) {
    const build = join(mkdtempSync(join(tmpdir(), 'duo-verify-')), 'build');
    cpSync(join(ROOT, 'sample/Encore'), build, { recursive: true });
    await page.goto(`${URL}#audit`);
    await page.getByTestId('folder-input').setInputFiles(build);
    assert((await findings(page)) === 31, 'a chosen folder is audited, even one named build');
    await proof(page, dir, 'folder');

    const zip = join(build, '..', 'Encore.zip');
    spawnSync('zip', ['-qr', zip, 'build'], { cwd: join(build, '..') });
    await page.goto(`${URL}#audit`);
    await page.getByTestId('zip-input').setInputFiles(zip);
    assert((await findings(page)) === 31, 'a zip made with the zip tool audits the same as the folder');
    await proof(page, dir, 'zip');
  },

  async rules(page, dir) {
    await page.goto(`${URL}#rules/keyboard-frame`);
    await page.waitForFunction(() => document.activeElement?.id === 'rule-keyboard-frame');
    assert((await page.locator('.rule').count()) === 28, 'all 28 rules listed');
    await proof(page, dir, 'rules');
  },

  async cli(_page, dir) {
    mkdirSync(dir, { recursive: true });
    const report = cli(['sample', '--no-color']);
    writeFileSync(join(dir, 'report.txt'), `${report.out}\n--- stderr\n${report.err}\nexit ${report.code}`);
    assert(report.code === 1 && report.out.includes('Fix these first'), 'text report exits 1 with errors and ranks screens');
    const dry = cli(['sample', '--dry-run', '--format', 'json', '--fail-on', 'never']);
    assert(JSON.parse(dry.out).findings.length === 31 && dry.err.includes('+++ b/Encore/Encore/LibraryView.swift'), 'dry run keeps JSON on stdout, diff on stderr');
    const copy = mkdtempSync(join(tmpdir(), 'duo-verify-'));
    cpSync(join(ROOT, 'sample'), copy, { recursive: true });
    const fixed = cli([copy, '--fix', '--no-color', '--fail-on', 'never']);
    writeFileSync(join(dir, 'fix.txt'), fixed.out);
    assert(readFileSync(join(copy, 'Encore/Encore/LibraryView.swift'), 'utf8').includes('NavigationStack {'), 'safe fixes are written to disk');
    assert(cli(['rules']).out.includes('game-aspect'), 'rules command lists every check');
  },
};

async function doctor() {
  const ok = await fetch(URL).then((r) => r.ok && r.text()).catch(() => false);
  const owned = existsSync(join(ROOT, 'dist/index.html')) && existsSync(join(ROOT, 'dist-cli/duo-ready.js'));
  console.log(`lab ${URL}: ${ok && ok.includes('duo-ready') ? 'up' : 'down'}; build present: ${owned}`);
  return !!ok && owned;
}

const args = process.argv.slice(2);
if (args[0] === 'doctor') process.exit((await doctor()) ? 0 : 1);
const names = !args.length || args[0] === 'all' ? Object.keys(FEATURES) : args;
for (const n of names) if (!FEATURES[n]) throw new Error(`Unknown feature ${n}. Known: ${Object.keys(FEATURES).join(', ')}`);

if (spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) throw new Error('npm run build failed');
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
let failed = 0;
try {
  for (let i = 0; i < 50 && !(await doctor().catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
  const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
  for (const name of names) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    console.log(name);
    try {
      await FEATURES[name](page, join(EVIDENCE, name));
      assert(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.log(`ISSUES ${name}: ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}
console.log(`Evidence: ${EVIDENCE}`);
process.exit(failed ? 1 : 0);
