import { resolve } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 8000),
  vaultPath: process.env.VAULT_PATH
    ? resolve(process.env.VAULT_PATH.replace(/^~/, homedir()))
    : resolve(projectRoot, 'example-vault'),
  dbPath: process.env.DB_PATH
    ? resolve(process.env.DB_PATH.replace(/^~/, homedir()))
    : resolve(projectRoot, 'index.db'),
};
