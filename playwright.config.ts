import { defineConfig, devices } from '@playwright/test';

const backendUrl = 'http://127.0.0.1:18000';
const frontendUrl = 'http://127.0.0.1:15173';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: frontendUrl,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command:
        'rm -rf /tmp/zk-e2e-vault /tmp/zk-e2e-index.db /tmp/zk-e2e-index.db-shm /tmp/zk-e2e-index.db-wal && cp -R example-vault /tmp/zk-e2e-vault && VAULT_PATH=/tmp/zk-e2e-vault DB_PATH=/tmp/zk-e2e-index.db PORT=18000 HOST=127.0.0.1 npm run start --workspace=backend',
      url: `${backendUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command:
        'BACKEND_URL=http://127.0.0.1:18000 npm run dev --workspace=frontend -- --host 127.0.0.1 --port 15173',
      url: frontendUrl,
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
