import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

// What a screen reader gets: names, groups, keyboard operation and live announcements.
// The accessibility tree stands in for VoiceOver, which only a real Mac can confirm.

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const projectZip = Buffer.from(zipSync({ 'MyApp/View.swift': strToU8('import UIKit\nlet s = UIScreen.main.scale\n') }));

test('every pose radio has a name inside a labelled Pose group, and the chosen one is checked', async ({ page }) => {
  await page.goto('./');
  const pose = page.getByRole('group', { name: 'Pose' });
  await expect(pose).toMatchAriaSnapshot(`
    - group "Pose":
      - radio "Closed"
      - radio "Closed, sideways"
      - radio "Open" [checked]
      - radio "Open, rotated"
      - radio "Split View"
      - radio "Half folded, book"
      - radio "Half folded, propped up"
  `);
  await expect(page.getByRole('group', { name: 'Build' }).getByRole('radio')).toHaveCount(4);
  // Radios stay in a roving tab order: one stop for the group, arrows move inside it.
  const radios = pose.getByRole('radio');
  for (let i = 0; i < 7; i++) expect(await radios.nth(i).evaluate((el) => (el as HTMLInputElement).name)).toBe('seg-pose');
});

test('arrow keys move through the poses, keep focus on the radio and announce the new pose', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('radio', { name: 'Open', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  const next = page.getByRole('radio', { name: 'Open, rotated', exact: true });
  await expect(next).toBeChecked();
  await expect(next).toBeFocused();
  await expect(page.locator('#announce')).toContainText('Open, rotated, iOS 26 SDK:');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Closed, sideways', exact: true })).toBeFocused();
  await expect(page.locator('#announce')).toContainText('Closed, sideways, iOS 26 SDK:');
});

test('the hidden file inputs are keyboard stops named by their visible buttons, with a visible focus ring', async ({ page }) => {
  await page.goto('./#audit');
  await page.locator('#main').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Choose folder' })).toBeFocused();
  await expect(page.locator('label.button:focus-within')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Choose .zip' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Try the sample app' })).toBeFocused();

  await page.goto('./');
  await page.getByRole('radio', { name: 'iOS 26 SDK' }).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab'); // past the three switches
  await expect(page.getByRole('button', { name: 'Try your own screenshot' })).toBeFocused();
  await expect(page.locator('label.button:focus-within')).toHaveCSS('outline-style', 'solid');
});

test('a chosen project is announced with its name, grade and finding count, and focus lands on the summary', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByTestId('zip-input').setInputFiles({ name: 'MyApp.zip', mimeType: 'application/zip', buffer: projectZip });
  await expect(page.getByRole('region', { name: 'Audit summary' })).toBeFocused();
  await expect(page.locator('#announce')).toHaveText(/^Audited MyApp\.zip: \d+ out of 100, .+, \d+ findings?\.$/);
});

test('the sample audit is announced too', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByRole('button', { name: 'Try the sample app' }).click();
  await expect(page.locator('#announce')).toHaveText(/^Audited Sample app: Encore: 10 out of 100, Not ready, 31 findings\.$/);
});

test('a project that cannot be read is announced and keyboard focus stays on the control that was used', async ({ page }) => {
  await page.goto('./#audit');
  await page.getByTestId('zip-input').focus();
  await page.getByTestId('zip-input').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('nope') });
  await expect(page.getByRole('alert')).toContainText('Could not read those files');
  await expect(page.getByRole('button', { name: 'Choose .zip' })).toBeFocused();

  await page.getByTestId('folder-input').focus();
  const empty = mkdtempSync(join(tmpdir(), 'duo-'));
  writeFileSync(join(empty, 'notes.txt'), 'hello');
  await page.getByTestId('folder-input').setInputFiles(empty);
  await expect(page.getByRole('alert')).toContainText('No Swift or Objective-C files');
  await expect(page.getByRole('button', { name: 'Choose folder' })).toBeFocused();
});

test('a chosen screenshot is announced, keeps focus on its control, and Remove hands focus back', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('shot-input').focus();
  await page.getByTestId('shot-input').setInputFiles({ name: 'home.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: 'Change screenshot' })).toBeFocused();
  await expect(page.locator('#announce')).toContainText('Screenshot home.png is showing in the iOS 26 SDK window.');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: 'Try your own screenshot' })).toBeFocused();
  await expect(page.locator('#announce')).not.toContainText('home.png');
});
