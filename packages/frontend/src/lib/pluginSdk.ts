import { api, type Card, type CardSummary, type Workspace, type WorkspaceEdge, type WorkspaceNode } from './api';
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
    addCards(workspaceId: string, cardIds: string[]): Promise<Workspace>;
    addEdge(
      workspaceId: string,
      sourceCardId: string,
      targetCardId: string,
      meta?: Pick<WorkspaceEdge, 'label' | 'note' | 'color'>,
    ): Promise<Workspace>;
    updateEdgeMeta(
      workspaceId: string,
      edgeId: string,
      meta: Pick<WorkspaceEdge, 'label' | 'note' | 'color'>,
    ): Promise<Workspace>;
  };
  ui: {
    openCard(id: string, opts?: { newTab?: boolean }): void;
    openWorkspace(id: string, opts?: { newTab?: boolean }): Promise<void>;
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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPluginSdk(pluginName: string, disposables: Array<() => void> = []): PluginSdk {
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
      async addCards(workspaceId, cardIds) {
        const ws = await api.getWorkspace(workspaceId);
        const existing = new Set(
          ws.nodes
            .filter((node): node is Extract<WorkspaceNode, { kind: 'card' }> => node.kind === 'card')
            .map((node) => node.cardId),
        );
        const nextNodes = [...ws.nodes];
        for (const cardId of cardIds) {
          const trimmed = cardId.trim();
          if (!trimmed || existing.has(trimmed)) continue;
          existing.add(trimmed);
          nextNodes.push({
            kind: 'card',
            id: uuid(),
            cardId: trimmed,
            x: 200 + nextNodes.length * 32,
            y: 200 + nextNodes.length * 24,
          });
        }
        return api.updateWorkspace(workspaceId, { nodes: nextNodes });
      },
      async addEdge(workspaceId, sourceCardId, targetCardId, meta = {}) {
        let next = await api.getWorkspace(workspaceId);
        const findNode = (cardId: string, ws: Workspace = next) =>
          ws.nodes.find(
            (node): node is Extract<WorkspaceNode, { kind: 'card' }> =>
              node.kind === 'card' && node.cardId === cardId,
          );
        if (!findNode(sourceCardId) || !findNode(targetCardId)) {
          const existing = new Set(
            next.nodes
              .filter((node): node is Extract<WorkspaceNode, { kind: 'card' }> => node.kind === 'card')
              .map((node) => node.cardId),
          );
          const nodes = [...next.nodes];
          for (const cardId of [sourceCardId, targetCardId]) {
            if (existing.has(cardId)) continue;
            existing.add(cardId);
            nodes.push({
              kind: 'card',
              id: uuid(),
              cardId,
              x: 200 + nodes.length * 32,
              y: 200 + nodes.length * 24,
            });
          }
          next = await api.updateWorkspace(workspaceId, { nodes });
        }
        const source = findNode(sourceCardId);
        const target = findNode(targetCardId);
        if (!source || !target) throw new Error('Unable to resolve workspace card nodes');
        const duplicate = next.edges.some(
          (edge) =>
            (edge.source === source.id && edge.target === target.id) ||
            (edge.source === target.id && edge.target === source.id),
        );
        if (duplicate) return next;
        return api.updateWorkspace(workspaceId, {
          edges: [
            ...next.edges,
            {
              id: uuid(),
              source: source.id,
              target: target.id,
              label: meta.label,
              note: meta.note,
              color: meta.color,
              applied: false,
            },
          ],
        });
      },
      async updateEdgeMeta(workspaceId, edgeId, meta) {
        const ws = await api.getWorkspace(workspaceId);
        return api.updateWorkspace(workspaceId, {
          edges: ws.edges.map((edge) =>
            edge.id === edgeId
              ? { ...edge, label: meta.label, note: meta.note, color: meta.color }
              : edge,
          ),
        });
      },
    },
    ui: {
      openCard(id, opts) {
        usePaneStore.getState().openTab(
          { kind: 'card', title: id, cardBoxId: id, cardFocusId: id },
          { newTab: opts?.newTab },
        );
      },
      async openWorkspace(id, opts) {
        const workspace = await api.getWorkspace(id);
        usePaneStore.getState().openTab(
          { kind: 'workspace', title: workspace.name, workspaceId: id },
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
    commands: {
      register(command) {
        const cleanup = registerCommand(command);
        disposables.push(cleanup);
        return cleanup;
      },
    },
    storage: createStorage(pluginName),
    registry: PluginRegistry,
    log: {
      log: (...args) => console.log(`[plugin:${pluginName}]`, ...args),
      warn: (...args) => console.warn(`[plugin:${pluginName}]`, ...args),
      error: (...args) => console.error(`[plugin:${pluginName}]`, ...args),
    },
  };
}
