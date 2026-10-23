import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Cloud containers ship Chromium here; elsewhere Playwright's own browser is used.
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// E2E_PORT lets several checkouts share one machine; 4178 is the default.
const port = Number(process.env.E2E_PORT ?? 4178);

export default defineConfig({
  testDir: 'tests/e2e',
  use: {
    baseURL: `http://localhost:${port}/`,
    launchOptions: existsSync(bundled) ? { executablePath: bundled } : {},
  },
  webServer: { command: `npx vite preview --port ${port} --strictPort`, port, reuseExistingServer: !process.env.CI },
});
