import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: 5178 },
  preview: { port: 4178 },
  define: { __VERSION__: JSON.stringify(process.env.npm_package_version ?? 'dev') },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
