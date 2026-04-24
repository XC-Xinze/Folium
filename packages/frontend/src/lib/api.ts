export type CardStatus = 'ATOMIC' | 'INDEX';

export interface IndexNode {
  luhmannId: string;
  title: string;
  status: CardStatus;
  children: IndexNode[];
}

export interface TagRelated {
  luhmannId: string;
  title: string;
  sharedTags: string[];
  jaccard: number;
}

export interface Card {
  luhmannId: string;
  title: string;
  status: CardStatus;
  parentId: string | null;
  sortKey: string;
  depth: number;
  contentMd: string;
  tags: string[];
  crossLinks: string[];
  filePath: string;
  mtime: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CardSummary {
  luhmannId: string;
  title: string;
  status: CardStatus;
  depth: number;
  tags: string[];
  sortKey: string;
  crossLinks: string[];
}

export interface RelatedBatch {
  [luhmannId: string]: {
    tagRelated: TagRelated[];
    potential: PotentialLink[];
  };
}

export interface SavedPosition {
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export type PositionMap = Record<string, SavedPosition>;

export interface CardRefNode {
  kind: 'card';
  id: string;
  cardId: string;
  x: number;
  y: number;
}
export interface TempCardNode {
  kind: 'temp';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
}
export interface NoteNode {
  kind: 'note';
  id: string;
  content: string;
  x: number;
  y: number;
}
export type WorkspaceNode = CardRefNode | TempCardNode | NoteNode;

export interface WorkspaceEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  applied?: boolean;
}

export interface WorkspaceLinkEndpoint {
  kind: 'card' | 'temp';
  id: string;
  title?: string;
  content?: string;
}

export interface WorkspaceLink {
  workspaceId: string;
  workspaceName: string;
  edgeId: string;
  source: WorkspaceLinkEndpoint;
  target: WorkspaceLinkEndpoint;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export interface ReferencedFromHit {
  sourceId: string;
  sourceTitle: string;
  paragraph: string;
}

export interface PotentialLink {
  luhmannId: string;
  title: string;
  score: number;
  reasons: string[];
}

const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ok: boolean; cards: number; vaultPath: string }>(`/health`),
  listCards: () => get<{ total: number; cards: CardSummary[] }>(`/cards`),
  getCard: (id: string) => get<Card>(`/cards/${encodeURIComponent(id)}`),
  getLinked: (id: string) => get<{ linked: Card[] }>(`/cards/${encodeURIComponent(id)}/linked`),
  getReferencedFrom: (id: string) =>
    get<{ hits: ReferencedFromHit[] }>(`/cards/${encodeURIComponent(id)}/referenced-from`),
  getPotential: (id: string) =>
    get<{ potential: PotentialLink[] }>(`/cards/${encodeURIComponent(id)}/potential`),
  listTags: () => get<{ tags: { name: string; count: number }[] }>(`/tags`),
  listIndexes: () => get<{ tree: IndexNode[] }>(`/indexes`),
  getTagRelated: (id: string) =>
    get<{ related: TagRelated[] }>(`/cards/${encodeURIComponent(id)}/tag-related`),
  getCardsByTag: (tag: string) =>
    get<{ tag: string; cards: Card[] }>(`/tags/${encodeURIComponent(tag)}/cards`),
  relatedBatch: async (ids: string[], potentialLimit = 5): Promise<RelatedBatch> => {
    const res = await fetch(`${BASE}/related-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, potentialLimit }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  getPositions: (scope: string) =>
    get<PositionMap>(`/positions/${encodeURIComponent(scope)}`),
  setPosition: async (
    scope: string,
    id: string,
    x: number,
    y: number,
    w?: number,
    h?: number,
  ): Promise<void> => {
    const res = await fetch(
      `${BASE}/positions/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, w, h }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  setSize: async (scope: string, id: string, w: number, h: number): Promise<void> => {
    const res = await fetch(
      `${BASE}/positions/${encodeURIComponent(scope)}/${encodeURIComponent(id)}/size`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ w, h }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  deletePosition: async (scope: string, id: string): Promise<void> => {
    await fetch(
      `${BASE}/positions/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },
  promoteCard: async (id: string): Promise<{ oldId: string; newId: string; filesUpdated: number }> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  deleteCard: async (id: string): Promise<{ deleted: string; filesUpdated: number; workspacesUpdated: number }> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  updateCard: async (
    id: string,
    patch: { title?: string; content?: string; tags?: string[]; status?: 'ATOMIC' | 'INDEX' },
  ): Promise<Card> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  renameTag: async (oldName: string, newName: string): Promise<{ filesUpdated: number; oldName: string; newName: string }> => {
    const res = await fetch(`${BASE}/tags/${encodeURIComponent(oldName)}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  deleteTag: async (name: string): Promise<{ filesUpdated: number; name: string }> => {
    const res = await fetch(`${BASE}/tags/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  demoteCard: async (id: string): Promise<{ oldId: string; newId: string; filesUpdated: number }> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}/demote`, {
      method: 'POST',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  // Workspaces
  listWorkspaces: () => get<{ workspaces: Workspace[] }>('/workspaces'),
  getWorkspace: (id: string) => get<Workspace>(`/workspaces/${encodeURIComponent(id)}`),
  createWorkspace: async (name: string): Promise<Workspace> => {
    const res = await fetch(`${BASE}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  updateWorkspace: async (id: string, patch: Partial<Pick<Workspace, 'name' | 'nodes' | 'edges'>>): Promise<Workspace> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  deleteWorkspace: async (id: string): Promise<void> => {
    await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  applyEdge: async (workspaceId: string, edgeId: string): Promise<void> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/apply-edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edgeId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
  },
  unapplyEdge: async (workspaceId: string, edgeId: string): Promise<void> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/unapply-edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edgeId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
  },
  deleteWorkspaceEdge: async (workspaceId: string, edgeId: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/edges/${encodeURIComponent(edgeId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
  },
  listStarred: () => get<{ ids: string[] }>(`/starred`),
  star: async (id: string): Promise<void> => {
    await fetch(`${BASE}/starred/${encodeURIComponent(id)}`, { method: 'PUT' });
  },
  unstar: async (id: string): Promise<void> => {
    await fetch(`${BASE}/starred/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  openOrCreateDaily: async (date?: string): Promise<{ luhmannId: string; created: boolean }> => {
    const res = await fetch(`${BASE}/daily`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  workspaceLinksBatch: async (cardIds: string[]): Promise<{ links: WorkspaceLink[] }> => {
    const res = await fetch(`${BASE}/workspace-links/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  tempToVault: async (workspaceId: string, nodeId: string, luhmannId: string): Promise<void> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/temp-to-vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, luhmannId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
  },
};
