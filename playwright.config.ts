import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real API, PostgreSQL and the built web app.
 * Locally they reuse running dev servers (API :3001, web :5173); in CI they start the built
 * API and `vite preview` — build with VITE_DATA_SOURCE=api first (a build without a data source refuses
 * to start, by design). The database must hold the synthetic seed (npm run db:reset -w @ccih/api).
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    // The suite logs in many times from one address: raise only the login throttling of this test server.
    { command: 'npm run start -w @ccih/api', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: !CI, timeout: 60_000, env: { LOGIN_RATE_LIMIT_PER_MINUTE: '60' } },
    { command: 'npm run preview -w @ccih/web -- --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: !CI, timeout: 60_000 },
  ],
});
