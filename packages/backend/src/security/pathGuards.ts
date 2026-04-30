import { basename, isAbsolute, normalize, resolve, sep } from 'node:path';

export function assertSafeFileName(fileName: string, allowedSuffix?: string): string {
  if (!fileName || fileName.includes('\0')) {
    throw new Error('bad file name');
  }
  const base = basename(fileName);
  if (base !== fileName || base === '.' || base === '..') {
    throw new Error('bad file name');
  }
  if (allowedSuffix && !base.endsWith(allowedSuffix)) {
    throw new Error('bad file type');
  }
  return base;
}

export function resolveInside(rootDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new Error('bad path');
  }
  const rel = normalize(relativePath.replace(/\\/g, '/'));
  if (rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) {
    throw new Error('bad path');
  }
  const root = resolve(rootDir);
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('path escapes root');
  }
  return target;
}
