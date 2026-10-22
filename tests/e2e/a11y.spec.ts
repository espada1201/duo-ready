import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pages: [string, (page: import('@playwright/test').Page) => Promise<void>][] = [
  ['preview', async (page) => void (await page.goto('./'))],
  [
    'preview, recommended build in Split View',
    async (page) => {
      await page.goto('./');
      await page.getByRole('radio', { name: '27.1 + recommended changes', exact: true }).check();
      await page.getByRole('radio', { name: 'Split View', exact: true }).check();
    },
  ],
  [
    'audit results',
    async (page) => {
      await page.goto('./#audit');
      await page.getByRole('button', { name: 'Try the sample app' }).click();
      await page.locator('.finding').first().waitFor();
    },
  ],
  [
    'partial audit',
    async (page) => {
      await page.goto('./#audit');
      await page.getByRole('button', { name: 'Paste Swift' }).click();
      await page.getByLabel('Swift source').fill('NavigationView {\n  Text("a")\n}');
      await page.getByRole('button', { name: 'Audit', exact: true }).click();
      await page.getByTestId('partial').waitFor();
    },
  ],
  ['empty audit', async (page) => void (await page.goto('./#audit'))],
  [
    'screenshot error',
    async (page) => {
      await page.goto('./');
      await page.getByTestId('shot-input').setInputFiles({ name: 'IMG.HEIC', mimeType: 'image/heic', buffer: Buffer.from('x') });
      await page.getByRole('alert').waitFor();
    },
  ],
  ['rules', async (page) => void (await page.goto('./#rules'))],
];

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    for (const [name, open] of pages) {
      test(`no serious accessibility violations: ${name}, ${scheme}, ${width}px`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await open(page);
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
      });
    }
  }
}
