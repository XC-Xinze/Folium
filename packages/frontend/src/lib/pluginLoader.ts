import { api } from './api';
import { PluginRegistry } from './pluginRegistry';
import { registerCommand } from './commands';
import { createPluginSdk, type PluginSdk } from './pluginSdk';

/**
 * 第三方插件加载：用户把 .js 放到 ${vault}/.zettel/plugins/，启动时遍历加载。
 *
 * 协议：插件文件须 `export default function activate(ctx) { ... }`，
 * 也可 `export function activate(...)`. ctx 暴露：
 *   - registry: PluginRegistry 子集
 *   - api: 后端 API
 *   - commands: { register }
 *   - log: console-like
 *
 * 沙箱：没有真隔离（浏览器原生 import 跑同 origin），同 Obsidian 套路。
 * 信任来源即可。
 */

export interface PluginContext {
  /** Stable v0 plugin SDK. Prefer this over direct api access. */
  sdk: PluginSdk;
  /** @deprecated Direct API access is kept for early plugins and may be narrowed later. */
  registry: typeof PluginRegistry;
  /** @deprecated Use sdk.cards / sdk.workspaces / sdk.ui instead. */
  api: typeof api;
  /** @deprecated Use sdk.commands instead. */
  commands: { register: typeof registerCommand };
  log: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface PluginManifest {
  id?: string;
  name?: string;
  version?: string;
  minAppVersion?: string;
  mobile?: boolean;
}

export interface LoadedPlugin {
  name: string;
  ok: boolean;
  error?: string;
  disabled?: boolean;
  manifest?: PluginManifest;
  /** activate 函数返回的 cleanup（如果有） */
  deactivate?: () => void;
}

const loaded = new Map<string, LoadedPlugin>();
const blobUrls = new Map<string, string>();
const DISABLED_KEY = 'zk-disabled-plugins';

function readDisabledPlugins(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(DISABLED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeDisabledPlugins(disabled: Set<string>): void {
  window.localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled].sort()));
}

export function listLoadedPlugins(): LoadedPlugin[] {
  return [...loaded.values()];
}

export function isPluginEnabled(name: string): boolean {
  return !readDisabledPlugins().has(name);
}

export function setPluginEnabled(name: string, enabled: boolean): void {
  const disabled = readDisabledPlugins();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeDisabledPlugins(disabled);
}

async function loadOne(name: string): Promise<LoadedPlugin> {
  if (!isPluginEnabled(name)) {
    return { name, ok: false, disabled: true, error: 'disabled' };
  }
  try {
    const src = await api.getPluginSource(name);
    // 用 Blob URL 让浏览器原生 import 可以解析
    const blob = new Blob([src], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    // 旧的 url 释放
    const oldUrl = blobUrls.get(name);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    blobUrls.set(name, url);

    const mod = (await import(/* @vite-ignore */ url)) as {
      manifest?: PluginManifest;
      default?: (ctx: PluginContext) => void | { deactivate?: () => void };
      activate?: (ctx: PluginContext) => void | { deactivate?: () => void };
    };
    const activate = mod.default ?? mod.activate;
    if (typeof activate !== 'function') {
      return { name, ok: false, error: 'no default export / activate function' };
    }
    const disposables: Array<() => void> = [];
    const ctx: PluginContext = {
      sdk: createPluginSdk(name, disposables),
      registry: PluginRegistry,
      api,
      commands: {
        register(command) {
          const cleanup = registerCommand(command);
          disposables.push(cleanup);
          return cleanup;
        },
      },
      log: {
        log: (...args) => console.log(`[plugin:${name}]`, ...args),
        warn: (...args) => console.warn(`[plugin:${name}]`, ...args),
        error: (...args) => console.error(`[plugin:${name}]`, ...args),
      },
    };
    const result = activate(ctx);
    const pluginDeactivate = result?.deactivate;
    const deactivate = () => {
      pluginDeactivate?.();
      for (const cleanup of [...disposables].reverse()) cleanup();
      disposables.length = 0;
    };
    return { name, ok: true, manifest: mod.manifest, deactivate };
  } catch (err) {
    return { name, ok: false, error: (err as Error).message };
  }
}

/** 加载所有插件（先卸载已加载的） */
export async function loadAllPlugins(): Promise<LoadedPlugin[]> {
  // 卸载旧的
  for (const p of loaded.values()) {
    try {
      p.deactivate?.();
    } catch (err) {
      console.warn('plugin deactivate failed', p.name, err);
    }
  }
  loaded.clear();

  const list = await api.listPlugins().catch(() => ({ plugins: [] }));
  for (const p of list.plugins) {
    const lp = await loadOne(p.name);
    loaded.set(p.name, lp);
  }
  return [...loaded.values()];
}

export async function reloadPlugins(): Promise<LoadedPlugin[]> {
  return loadAllPlugins();
}
