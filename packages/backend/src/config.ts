import { resolve } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');

const initialVaultPath = process.env.VAULT_PATH
  ? resolve(process.env.VAULT_PATH.replace(/^~/, homedir()))
  : resolve(projectRoot, 'example-vault');

// vaultPath 是 mutable 的：vault switcher 调 setActiveVaultPath 切换。
// 用 getter 让所有 `config.vaultPath` 的现有调用自动拿到最新值，不必到处改 import。
let activeVaultPath = initialVaultPath;

export function getActiveVaultPath(): string {
  return activeVaultPath;
}

export function setActiveVaultPath(path: string): void {
  activeVaultPath = resolve(path.replace(/^~/, homedir()));
}

export const config = {
  port: Number(process.env.PORT ?? 8000),
  get vaultPath(): string {
    return activeVaultPath;
  },
  dbPath: process.env.DB_PATH
    ? resolve(process.env.DB_PATH.replace(/^~/, homedir()))
    : resolve(projectRoot, 'index.db'),
};
