import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Cloud containers ship Chromium here; elsewhere Playwright's own browser is used.
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  use: {
    baseURL: 'http://localhost:4178/',
    launchOptions: existsSync(bundled) ? { executablePath: bundled } : {},
  },
  webServer: { command: 'npx vite preview --port 4178 --strictPort', port: 4178, reuseExistingServer: !process.env.CI },
});
