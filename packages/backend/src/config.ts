import { resolve } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
const useExampleVault = process.env.FOLIUM_DISABLE_EXAMPLE_VAULT !== '1';

const initialVaultPath = process.env.VAULT_PATH
  ? resolve(process.env.VAULT_PATH.replace(/^~/, homedir()))
  : useExampleVault
    ? resolve(projectRoot, 'example-vault')
    : null;

// vaultPath 是 mutable 的：vault switcher 调 setActiveVaultPath 切换。
// 用 getter 让所有 `config.vaultPath` 的现有调用自动拿到最新值，不必到处改 import。
let activeVaultPath: string | null = initialVaultPath;

export function getActiveVaultPath(): string | null {
  return activeVaultPath;
}

export function setActiveVaultPath(path: string): void {
  activeVaultPath = resolve(path.replace(/^~/, homedir()));
}

export const config = {
  port: Number(process.env.PORT ?? 8000),
  host: process.env.HOST ?? '127.0.0.1',
  apiToken: process.env.FOLIUM_API_TOKEN ?? '',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  get vaultPath(): string {
    if (!activeVaultPath) {
      throw new Error('No active vault selected');
    }
    return activeVaultPath;
  },
  dbPath: process.env.DB_PATH
    ? resolve(process.env.DB_PATH.replace(/^~/, homedir()))
    : resolve(projectRoot, 'index.db'),
};
