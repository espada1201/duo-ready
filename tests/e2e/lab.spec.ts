import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

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

  await choose(page, '27.1 + duo-ready');
  await expect(page.getByTestId('problems')).toContainText('No collisions');
  await expect(page.locator('.overlay-collision')).toHaveCount(0);
  await expect(page.locator('.enc-list')).toBeVisible();
  await expect(page.locator('.enc-rail')).toBeVisible();

  await choose(page, 'Closed');
  await expect(page.locator('.enc-list')).toHaveCount(0);
  await expect(page.locator('.enc-mini')).toBeVisible();
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
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.shot')).toHaveCount(0);
});

test('auditing the sample app lists findings and downloads working fixes', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  await expect(page.getByTestId('grade')).toHaveText('Not ready');
  await expect(page.locator('.finding')).toHaveCount(19);
  await expect(page.getByTestId('download')).toHaveText('Download 2 fixes');

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

  await page.getByRole('button', { name: 'Preview on Duo' }).click();
  await expect(page).toHaveURL(/#preview$/);
  await expect(page.getByRole('radio', { name: 'iOS 26 SDK' })).toBeChecked();
});

test('auditing a chosen folder, pasted code, and a folder with nothing to audit', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByTestId('folder-input').setInputFiles('sample');
  await expect(page.locator('.finding')).toHaveCount(19);

  await page.getByRole('button', { name: 'Paste Swift' }).click();
  await page.getByLabel('Swift source').fill('final class A: UIViewController {\n  func f() { let s = UIScreen.main.scale }\n}');
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await expect(page.locator('.finding')).toHaveCount(1);
  await expect(page.locator('.diff')).toContainText('traitCollection.displayScale');

  await page.getByTestId('folder-input').setInputFiles('tests/e2e');
  await expect(page.getByRole('alert')).toContainText('No Swift files');
});

test('rule links deep-link and focus the rule', async ({ page }) => {
  await page.goto('./#rules/hand-built-bar');
  await expect(page.locator('#rule-hand-built-bar')).toBeFocused();
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await expect(page).toHaveURL(/#rules\/hand-built-bar$/);
  await expect(page.locator('.rule')).toHaveCount(17);
});
