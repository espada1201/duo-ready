import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const choose = (page: Page, name: string) => page.getByRole('radio', { name, exact: true }).check();

test('preview walks from letterboxed legacy app to a fixed app that clears the hinge', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('window')).toHaveText('430 × 626 pt, 48% of the display');
  await expect(page.getByTestId('problems')).toContainText('52% of the display is left black');

  await choose(page, 'Book');
  await expect(page.getByTestId('problems')).toContainText('The hinge cuts through');

  await choose(page, 'iOS 27.1 SDK');
  await expect(page.getByTestId('window')).toHaveText('890 × 626 pt, 100% of the display');
  await expect(page.getByTestId('problems')).toContainText('The status bar cuts through the custom navigation bar');
  await expect(page.locator('.overlay-collision').first()).toBeVisible();

  await choose(page, '27.1 + recommended changes');
  await expect(page.getByTestId('problems')).toContainText('No collisions');
  await expect(page.getByTestId('changes')).toContainText('duo-ready appliesNavigationView becomes NavigationStack');
  await expect(page.getByTestId('changes')).toContainText('You changePlayer and Up next sit in an ArrangementView');
  await expect(page.locator('.overlay-collision')).toHaveCount(0);
  await expect(page.locator('.enc-list')).toBeVisible();
  await expect(page.locator('.enc-rail')).toBeVisible();

  await choose(page, 'Closed');
  await expect(page.locator('.enc-list')).toHaveCount(0);
  await expect(page.locator('.enc-mini')).toBeVisible();
});

test('fold test shows unchanged code losing its place and the fixed build keeping it', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('continuity')).toContainText('Switch between Closed and Open');
  await choose(page, 'iOS 27.1 SDK');
  await choose(page, 'Closed');
  await choose(page, 'Open');
  await expect(page.getByTestId('continuity')).toContainText('Fold test: closed → open');
  await expect(page.getByTestId('continuity')).toContainText('Lost: your scroll position in the album list');
  await choose(page, '27.1 + recommended changes');
  await choose(page, 'Closed');
  await expect(page.getByTestId('continuity')).toContainText('the layout changed, the views didn’t');
});

test('Split View gives the app half the inner display at compact width', async ({ page }) => {
  await page.goto('./');
  await choose(page, 'iOS 27.1 SDK');
  await choose(page, 'Split View');
  await expect(page.getByTestId('window')).toHaveText('445 × 626 pt, 100% of its half of the display');
  await expect(page.locator('.other-app')).toBeVisible();
  await expect(page.getByTestId('continuity')).toContainText('Lost: your scroll position in the album list');
});

test('pose control works from the keyboard and keeps focus', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('radio', { name: 'Open', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Open, rotated' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Open, rotated' })).toBeFocused();
  await expect(page.getByTestId('window')).toContainText('466 × 678 pt');
});

test('a screenshot of your own app appears in the compatibility window', async ({ page }) => {
  await page.goto('./');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('shot-input').setInputFiles({ name: 'app.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByAltText('Your app screenshot in the compatibility window')).toBeVisible();
  await expect(page.getByTestId('shot-hidden')).toHaveCount(0);
  await choose(page, 'Closed');
  await expect(page.getByTestId('shot-hidden')).toBeVisible();
  await choose(page, 'Open');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.shot')).toHaveCount(0);
});

test('a screenshot the browser cannot draw gets a reason instead of a broken image', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('shot-input').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really an image') });
  await expect(page.getByRole('alert')).toHaveText("This browser can't show IMG_0001.HEIC. Use a PNG or JPEG screenshot.");
  await expect(page.locator('.shot')).toHaveCount(0);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('shot-input').setInputFiles({ name: 'app.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.shot')).toHaveCount(1);
  await expect(page.getByTestId('shot-error')).toHaveCount(0);
});

test('auditing the sample app lists findings and downloads working fixes', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  await expect(page.getByTestId('grade')).toHaveText('Not ready');
  await expect(page.locator('.finding')).toHaveCount(31);
  await expect(page.getByTestId('screens')).toContainText('PlayerViewController');
  await expect(page.getByTestId('partial')).toHaveCount(0);
  await expect(page.getByTestId('download')).toHaveText('Download 2 fixes');
  await expect(page.getByRole('list', { name: 'Findings by reviewer pain point' })).toContainText('Assumes iPhone hardware3');

  // Opt into the review-level sidebar fix too.
  const sidebar = page.locator('.finding[data-rule="tab-sidebar"] input[type=checkbox]');
  await sidebar.check();
  await expect(sidebar).toBeFocused();
  await expect(page.getByTestId('download')).toHaveText('Download 3 fixes');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const zip = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(Object.keys(zip).sort()).toEqual(['Encore/Encore/LibraryView.swift', 'Encore/Encore/PlayerViewController.swift']);
  const library = strFromU8(zip['Encore/Encore/LibraryView.swift']);
  expect(library).toContain('NavigationStack {');
  expect(library).toContain('.defaultTabBarPlacement(.sidebar)');
  expect(strFromU8(zip['Encore/Encore/PlayerViewController.swift'])).toContain('view.bounds.inset(by: view.safeAreaInsets).width');

  const [patchFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the fixes as a patch' }).click()]);
  const patch = readFileSync((await patchFile.path())!, 'utf8');
  expect(patchFile.suggestedFilename()).toBe('duo-ready-fixes.patch');
  expect(patch).toContain('+++ b/Encore/Encore/LibraryView.swift');
  expect(patch).toContain('+        .defaultTabBarPlacement(.sidebar)');
  expect(patch).toContain('[review fix]');

  await page.getByRole('button', { name: 'Preview on Duo' }).click();
  await expect(page).toHaveURL(/#preview$/);
  await expect(page.getByRole('radio', { name: 'iOS 26 SDK' })).toBeChecked();
});

test('auditing a chosen folder, pasted code, and a folder with nothing to audit', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByTestId('folder-input').setInputFiles('sample');
  await expect(page.locator('.finding')).toHaveCount(31);

  await page.getByRole('button', { name: 'Paste Swift' }).click();
  await page.getByLabel('Swift source').fill('final class A: UIViewController {\n  func f() { let s = UIScreen.main.scale }\n}');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.locator('.diff')).toContainText('  func f() { let s = self.traitCollection.displayScale }');
  await expect(page.getByTestId('partial')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Findings by reviewer pain point' })).toContainText('Black barsnot checked');

  // A project kept in a folder named like build output is still audited.
  const build = join(mkdtempSync(join(tmpdir(), 'duo-')), 'build');
  cpSync('sample/Encore', build, { recursive: true });
  await page.getByTestId('folder-input').setInputFiles(build);
  await expect(page.locator('.finding')).toHaveCount(31);

  await page.getByTestId('folder-input').setInputFiles('tests/e2e');
  await expect(page.getByRole('alert')).toContainText('No Swift files');
});

test('audit controls keep keyboard focus and results take it', async ({ page }) => {
  await page.goto('./#audit');
  const paste = page.getByRole('button', { name: 'Paste Swift' });
  await paste.focus();
  await page.keyboard.press('Enter');
  await expect(paste).toBeFocused();
  await expect(paste).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Try the sample app' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Audit summary' })).toBeFocused();
});

test('changing tabs moves focus to the new panel and pose changes are announced', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#announce')).toHaveText(/^Open, .+: \d+ problems? in this pose\.$/);
  await choose(page, 'Closed');
  await expect(page.locator('#announce')).toContainText('Closed, ');
  await expect(page.locator('#announce')).toContainText('Fold test:');
  await page.getByRole('link', { name: 'Audit', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('pasted code survives a trip to another tab, and long paths wrap on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Paste Swift' }).click();
  await page.getByLabel('Swift source').fill('let s = UIScreen.main.scale');
  await page.goto('./#rules');
  await page.goBack();
  await expect(page.getByLabel('Swift source')).toHaveValue('let s = UIScreen.main.scale');

  const deep = join(mkdtempSync(join(tmpdir(), 'duo-')), 'App', 'Sources', 'Features', 'Settings', 'Notifications', 'Preferences');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'NotificationPreferencesDetailViewController.swift'), 'class NotificationPreferencesDetailViewController: UIViewController { let s = UIScreen.main.scale }');
  await page.getByTestId('folder-input').setInputFiles(join(deep, '..', '..', '..', '..', '..'));
  await expect(page.getByTestId('screens')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('findings filter by severity, pain point and fixability', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  const findings = page.locator('.finding');
  await expect(findings).toHaveCount(31);

  const errors = page.getByRole('button', { name: '8 errors' });
  await errors.click();
  await expect(errors).toBeFocused();
  await expect(errors).toHaveAttribute('aria-pressed', 'true');
  await expect(findings).toHaveCount(8);
  await expect(page.locator('.finding.sev-error')).toHaveCount(8);
  await expect(page.getByTestId('filter-count')).toContainText('Showing 8 of 31');

  await page.getByRole('button', { name: /^All 31$/ }).click();
  const withFix = await page.locator('.finding .fix').count();
  expect(withFix).toBeGreaterThan(0);
  await page.getByLabel('Only findings with a fix').check();
  await expect(findings).toHaveCount(withFix);
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(findings).toHaveCount(31);

  const chip = page.getByRole('button', { name: /^Show only the \d+ black bars/i });
  const n = Number(await chip.textContent());
  await chip.click();
  await expect(findings).toHaveCount(n);
  await chip.click();
  await expect(findings).toHaveCount(31);

  // Chips share numbers; focus must stay on the one pressed, and Show all lands on All.
  const hinge = page.getByRole('button', { name: /^Show only the \d+ .*hinge/i });
  await hinge.focus();
  await page.keyboard.press('Enter');
  await expect(hinge).toBeFocused();
  await expect(hinge).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Show all' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^All 31$/ })).toBeFocused();
});

test('a newer audit wins over a slow one still running', async ({ page }) => {
  await page.goto('./#audit');
  const dir = mkdtempSync(join(tmpdir(), 'duo-'));
  writeFileSync(join(dir, 'Fonts.swift'), Array.from({ length: 25000 }, (_, i) => `let f${i} = UIFont.systemFont(ofSize: 12)`).join('\n'));
  await page.getByTestId('folder-input').setInputFiles(dir);
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  await expect(page.locator('.finding')).toHaveCount(31);
  await page.waitForTimeout(3000);
  await expect(page.locator('.eyebrow')).toHaveText('Sample app: Encore');
  await expect(page.locator('.finding')).toHaveCount(31);
});

test('a zipped project audits like the folder, ignoring the zip\'s top folder and macOS junk', async ({ page }) => {
  const files: Record<string, Uint8Array> = { '__MACOSX/Encore-main/._LibraryView.swift': new Uint8Array([0, 5, 22, 7]) };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[`Encore-main/${relative('sample', full)}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk('sample');
  await page.goto('./#audit');
  await page.getByTestId('zip-input').setInputFiles({ name: 'Encore-main.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  await expect(page.getByTestId('grade')).toHaveText('Not ready');
  await expect(page.locator('.finding')).toHaveCount(31);
  await expect(page.getByTestId('findings')).toContainText('Encore/Encore/');
  await expect(page.getByTestId('findings')).not.toContainText('Encore-main');
});

test('a zip without a top folder keeps its folder names, so a watch app stays skipped', async ({ page }) => {
  const files = {
    'App/Root.swift': strToU8('let s = UIScreen.main.scale'),
    'MyWatchApp/W.swift': strToU8('let s = UIScreen.main.scale'),
    'README.md': strToU8('notes'),
  };
  await page.goto('./#audit');
  await page.getByTestId('zip-input').setInputFiles({ name: 'build.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.getByTestId('findings')).toContainText('App/Root.swift');
});

test('dropping loose Swift files audits them', async ({ page }) => {
  await page.goto('./#audit');
  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['let s = UIScreen.main.scale'], 'Scale.swift'));
    data.items.add(new File(['binary'], 'logo.png'));
    return data;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer: drop });
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.locator('.finding')).toContainText('UIScreen.main');
});

test('rule links deep-link and focus the rule', async ({ page }) => {
  await page.goto('./#rules/hand-built-bar');
  await expect(page.locator('#rule-hand-built-bar')).toBeFocused();
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await expect(page).toHaveURL(/#rules\/hand-built-bar$/);
  await expect(page.locator('.rule')).toHaveCount(28);
});

test('pain point chips open their section on the rules page', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  await page.getByRole('link', { name: 'Breaks when you fold or unfold' }).click();
  await expect(page).toHaveURL(/#rules\/pain-fold$/);
  await expect(page.locator('#pain-fold')).toBeFocused();
});
