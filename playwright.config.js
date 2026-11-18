import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false, // every test shares the single "playwright" room
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    { command: 'node scripts/serve.js 8080', url: 'http://localhost:8080', reuseExistingServer: !process.env.CI },
    {
      command: 'npx wrangler dev --config worker/wrangler.toml --port 8787 --persist-to .wrangler-e2e',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
