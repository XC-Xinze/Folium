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
}
export type PositionMap = Record<string, SavedPosition>;

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
  getPositions: () => get<PositionMap>('/positions'),
  setPosition: async (id: string, x: number, y: number): Promise<void> => {
    const res = await fetch(`${BASE}/positions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  deletePosition: async (id: string): Promise<void> => {
    await fetch(`${BASE}/positions/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
};
