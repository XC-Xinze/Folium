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
  /** crossLinks 中由动态查询自动加入的成员（INDEX 卡可能有） */
  autoMembers?: string[];
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
  w?: number;
  h?: number;
}
export interface TempCardNode {
  kind: 'temp';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export interface NoteNode {
  kind: 'note';
  id: string;
  content: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export type WorkspaceNode = CardRefNode | TempCardNode | NoteNode;

export interface WorkspaceEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  color?: string;
  note?: string;
  applied?: boolean;
  /** True when this edge mirrors an existing vault [[link]], not a workspace draft. */
  vaultLink?: boolean;
  /** True when this edge mirrors vault structure such as Folgezettel parent-child. */
  vaultStructure?: boolean;
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

export interface FontSettings {
  ui: string;
  body: string;
  display: string;
  mono: string;
}

export interface VaultSettings {
  attachmentPolicy: 'global' | 'per-box';
  backupEnabled: boolean;
  backupIntervalHours: number;
  backupKeep: number;
  fonts: FontSettings;
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

export interface VaultEntry {
  id: string;
  path: string;
  name: string;
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
  getDiscoveries: () =>
    get<{
      clusters: Array<{
        cards: Array<{ luhmannId: string; title: string }>;
        hintTags: string[];
      }>;
    }>(`/discoveries`),
  getTagSuggestions: (id: string) =>
    get<{ suggestions: Array<{ name: string; score: number }> }>(
      `/cards/${encodeURIComponent(id)}/tag-suggestions`,
    ),
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
    patch: { title?: string; content?: string; tags?: string[] },
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
  repairWorkspaces: async (): Promise<{
    workspacesScanned: number;
    nodesRemoved: number;
    edgesRemoved: number;
    edgesNormalized: number;
    duplicatesMerged: number;
  }> => {
    const res = await fetch(`${BASE}/workspaces/repair`, { method: 'POST' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  deleteWorkspace: async (id: string): Promise<void> => {
    await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  restoreWorkspace: async (id: string): Promise<void> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
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
  // ──── 回收站 ────
  listTrash: () =>
    get<{
      entries: Array<{
        fileName: string;
        luhmannId: string;
        title: string;
        deletedAt: string;
        mtime: number;
      }>;
    }>(`/trash`),
  restoreTrash: async (
    fileName: string,
    strategy: 'fail' | 'next-available' | 'replace' = 'fail',
  ): Promise<{ luhmannId: string; conflict?: boolean; replacedExisting?: boolean }> => {
    const res = await fetch(`${BASE}/trash/${encodeURIComponent(fileName)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  // Workspace + temp 的 trash
  listWsTrash: () =>
    get<{ entries: Array<{ fileName: string; workspace: { id: string; name: string }; deletedAt: string }> }>(
      `/trash/workspaces`,
    ),
  restoreWsTrash: async (fileName: string): Promise<{ id: string; name: string }> => {
    const res = await fetch(`${BASE}/trash/workspaces/${encodeURIComponent(fileName)}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  purgeWsTrash: async (fileName: string): Promise<void> => {
    await fetch(`${BASE}/trash/workspaces/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
  },
  listTempTrash: () =>
    get<{ entries: Array<{ fileName: string; workspaceId: string; workspaceName: string; node: { title: string; content: string }; deletedAt: string }> }>(
      `/trash/temps`,
    ),
  restoreTempTrash: async (fileName: string): Promise<{ ok: true; workspaceId: string }> => {
    const res = await fetch(`${BASE}/trash/temps/${encodeURIComponent(fileName)}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  purgeTempTrash: async (fileName: string): Promise<void> => {
    await fetch(`${BASE}/trash/temps/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
  },
  /** workspace 内删一个 node（temp 自动入 trash 可还原；card/note 直接移除） */
  deleteWorkspaceNode: async (workspaceId: string, nodeId: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
  },
  purgeTrashEntry: async (fileName: string): Promise<void> => {
    await fetch(`${BASE}/trash/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
  },
  emptyTrash: async (): Promise<{ purged: number }> => {
    const res = await fetch(`${BASE}/trash/empty`, { method: 'POST' });
    return res.json();
  },
  search: (q: string, limit = 20) =>
    get<{ hits: Array<{ luhmannId: string; title: string; snippet: string; rank: number }> }>(
      `/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
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
  createCard: async (body: {
    luhmannId: string;
    title: string;
    content?: string;
    tags?: string[];
    crossLinks?: string[];
  }): Promise<{ luhmannId: string }> => {
    const res = await fetch(`${BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  exportCardUrl: (id: string) => `${BASE}/export/card/${encodeURIComponent(id)}`,
  exportSubtreeUrl: (id: string) => `${BASE}/export/subtree/${encodeURIComponent(id)}`,
  exportVaultUrl: () => `${BASE}/export/vault`,
  searchReplace: async (input: {
    query: string;
    replacement: string;
    useRegex?: boolean;
    caseSensitive?: boolean;
    bodyOnly?: boolean;
    dryRun?: boolean;
  }): Promise<{
    changes: Array<{ luhmannId: string; title: string; count: number; preview: string }>;
    totalCount: number;
    filesUpdated: number;
  }> => {
    const res = await fetch(`${BASE}/search-replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  listPlugins: () =>
    get<{ plugins: Array<{ name: string; size: number; mtime: number }> }>(`/plugins`),
  getPluginSource: async (name: string): Promise<string> => {
    const res = await fetch(`${BASE}/plugins/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  },
  uploadAttachment: async (
    file: File,
    boxId?: string | null,
  ): Promise<{ filename: string; relativePath: string; url: string; mimetype: string; size: number }> => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const url = boxId
      ? `${BASE}/attachments?boxId=${encodeURIComponent(boxId)}`
      : `${BASE}/attachments`;
    const res = await fetch(url, { method: 'POST', body: fd });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  nextChildId: async (parentId: string | null): Promise<{ luhmannId: string }> => {
    const res = await fetch(`${BASE}/cards/next-child-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  reparentCard: async (
    sourceId: string,
    newParentId: string | null,
    opts?: { dryRun?: boolean },
  ): Promise<{ renames: Record<string, string>; filesUpdated: number; workspacesUpdated?: number; dryRun?: boolean }> => {
    const res = await fetch(`${BASE}/cards/reparent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, newParentId, dryRun: opts?.dryRun }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  removeCrossLink: async (sourceId: string, targetId: string): Promise<{ removed: boolean }> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(sourceId)}/remove-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  appendCrossLink: async (sourceId: string, targetId: string): Promise<{ alreadyLinked: boolean }> => {
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(sourceId)}/append-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  openAttachment: async (relativePath: string): Promise<{ ok: boolean }> => {
    const res = await fetch(`${BASE}/attachments/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  // 备份 endpoints
  listBackups: () =>
    get<{ entries: Array<{ fileName: string; size: number; createdAt: string }> }>(`/backups`),
  createBackupNow: async (): Promise<{ fileName: string }> => {
    const res = await fetch(`${BASE}/backups`, { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  restoreBackup: async (fileName: string): Promise<{ ok: true }> => {
    const res = await fetch(`${BASE}/backups/${encodeURIComponent(fileName)}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  purgeBackup: async (fileName: string): Promise<void> => {
    await fetch(`${BASE}/backups/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
  },
  rebuildIndex: async (): Promise<{ ok: true; cards: number; durationMs: number }> => {
    const res = await fetch(`${BASE}/vault-settings/rebuild-index`, { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  getVaultSettings: () =>
    get<{
      settings: VaultSettings;
    }>(`/vault-settings`),
  patchVaultSettings: async (
    patch: Partial<VaultSettings>,
  ): Promise<{ settings: VaultSettings }> => {
    const res = await fetch(`${BASE}/vault-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
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
  listVaults: () => get<{ vaults: VaultEntry[]; active: VaultEntry | null }>(`/vaults`),
  getActiveVault: () => get<{ active: VaultEntry | null }>(`/vaults/active`),
  registerVault: async (path: string, name?: string): Promise<{ vault: VaultEntry }> => {
    const res = await fetch(`${BASE}/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  unregisterVault: async (id: string): Promise<{ removed: VaultEntry; switchedTo: VaultEntry | null }> => {
    const res = await fetch(`${BASE}/vaults/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  switchVault: async (id: string): Promise<{ active: VaultEntry; cards: number; durationMs: number }> => {
    const res = await fetch(`${BASE}/vaults/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
  tempToVault: async (
    workspaceId: string,
    nodeId: string,
    luhmannId: string,
  ): Promise<{ ok: true; luhmannId: string; failedEdges?: string[] }> => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/temp-to-vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, luhmannId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },
};
