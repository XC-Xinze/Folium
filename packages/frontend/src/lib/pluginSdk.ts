import { api, type Card, type CardSummary, type Workspace } from './api';
import { registerCommand, type Command } from './commands';
import { dialog } from './dialog';
import { PluginRegistry } from './pluginRegistry';
import { usePaneStore } from '../store/paneStore';

export interface PluginStorage {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

export interface PluginSdk {
  cards: {
    list(): Promise<CardSummary[]>;
    get(id: string): Promise<Card>;
    create(input: {
      luhmannId: string;
      title: string;
      content?: string;
      tags?: string[];
      crossLinks?: string[];
    }): Promise<{ luhmannId: string }>;
    update(id: string, patch: { title?: string; content?: string; tags?: string[] }): Promise<Card>;
    search(q: string, limit?: number): ReturnType<typeof api.search>;
    star(id: string): Promise<void>;
    unstar(id: string): Promise<void>;
  };
  workspaces: {
    list(): Promise<Workspace[]>;
    get(id: string): Promise<Workspace>;
    create(name: string): Promise<Workspace>;
    update(id: string, patch: Partial<Pick<Workspace, 'name' | 'nodes' | 'edges'>>): Promise<Workspace>;
  };
  ui: {
    openCard(id: string, opts?: { newTab?: boolean }): void;
    openGraph(opts?: { newTab?: boolean }): void;
    openSettings(opts?: { newTab?: boolean }): void;
    alert(message: string, opts?: { title?: string }): Promise<void>;
  };
  commands: {
    register(command: Command): () => void;
  };
  storage: PluginStorage;
  registry: typeof PluginRegistry;
  log: Pick<Console, 'log' | 'warn' | 'error'>;
}

function createStorage(pluginName: string): PluginStorage {
  const prefix = `zk-plugin:${pluginName}:`;
  return {
    get<T>(key: string, fallback: T): T {
      const raw = window.localStorage.getItem(prefix + key);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    set<T>(key: string, value: T): void {
      window.localStorage.setItem(prefix + key, JSON.stringify(value));
    },
    remove(key: string): void {
      window.localStorage.removeItem(prefix + key);
    },
  };
}

export function createPluginSdk(pluginName: string): PluginSdk {
  return {
    cards: {
      list: async () => (await api.listCards()).cards,
      get: api.getCard,
      create: api.createCard,
      update: api.updateCard,
      search: api.search,
      star: api.star,
      unstar: api.unstar,
    },
    workspaces: {
      list: async () => (await api.listWorkspaces()).workspaces,
      get: api.getWorkspace,
      create: api.createWorkspace,
      update: api.updateWorkspace,
    },
    ui: {
      openCard(id, opts) {
        usePaneStore.getState().openTab(
          { kind: 'card', title: id, cardBoxId: id, cardFocusId: id },
          { newTab: opts?.newTab },
        );
      },
      openGraph(opts) {
        usePaneStore.getState().openTab({ kind: 'graph', title: 'Graph' }, { newTab: opts?.newTab });
      },
      openSettings(opts) {
        usePaneStore.getState().openTab({ kind: 'settings', title: 'Settings' }, { newTab: opts?.newTab });
      },
      alert: dialog.alert,
    },
    commands: { register: registerCommand },
    storage: createStorage(pluginName),
    registry: PluginRegistry,
    log: {
      log: (...args) => console.log(`[plugin:${pluginName}]`, ...args),
      warn: (...args) => console.warn(`[plugin:${pluginName}]`, ...args),
      error: (...args) => console.error(`[plugin:${pluginName}]`, ...args),
    },
  };
}
