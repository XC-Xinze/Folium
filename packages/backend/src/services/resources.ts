import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { CardRepository } from '../vault/repository.js';
import { resolveInside } from '../security/pathGuards.js';

const ZETTEL_DIR = '.zettel';
const RESOURCE_FILE = 'resources.json';

export interface ResourceCard {
  id: string;
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'file';
  title: string;
  path: string;
  tags: string[];
  parentBoxId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface ResourceStore {
  resources: ResourceCard[];
}

const storePath = () => join(config.vaultPath, ZETTEL_DIR, RESOURCE_FILE);

async function loadStore(): Promise<ResourceStore> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ResourceStore>;
    return {
      resources: Array.isArray(parsed.resources) ? parsed.resources.map(normalizeResource).filter(Boolean) as ResourceCard[] : [],
    };
  } catch {
    return { resources: [] };
  }
}

async function saveStore(store: ResourceStore): Promise<void> {
  await mkdir(join(config.vaultPath, ZETTEL_DIR), { recursive: true });
  await writeFile(storePath(), JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function normalizeResource(input: unknown): ResourceCard | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Partial<ResourceCard>;
  if (!r.id || !r.path || !r.title) return null;
  return {
    id: String(r.id),
    kind: isResourceKind(r.kind) ? r.kind : inferKindFromPath(String(r.path)),
    title: String(r.title),
    path: String(r.path),
    tags: Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean) : [],
    parentBoxId: r.parentBoxId ? String(r.parentBoxId) : null,
    note: r.note ? String(r.note) : '',
    createdAt: r.createdAt ? String(r.createdAt) : new Date().toISOString(),
    updatedAt: r.updatedAt ? String(r.updatedAt) : new Date().toISOString(),
  };
}

export async function listResources(parentBoxId?: string | null): Promise<ResourceCard[]> {
  const store = await loadStore();
  const list = parentBoxId === undefined
    ? store.resources
    : store.resources.filter((resource) => resource.parentBoxId === parentBoxId);
  return list.slice().sort((a, b) => a.title.localeCompare(b.title) || a.createdAt.localeCompare(b.createdAt));
}

export async function createResource(input: {
  kind?: ResourceCard['kind'];
  title: string;
  path: string;
  tags?: string[];
  parentBoxId?: string | null;
  note?: string;
}): Promise<ResourceCard> {
  const store = await loadStore();
  const now = new Date().toISOString();
  const resource: ResourceCard = {
    id: `res_${randomUUID()}`,
    kind: input.kind ?? inferKindFromPath(input.path),
    title: input.title.trim() || 'Untitled image',
    path: input.path,
    tags: input.tags ?? [],
    parentBoxId: input.parentBoxId?.trim() || null,
    note: input.note?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
  };
  store.resources.push(resource);
  await saveStore(store);
  return resource;
}

export async function getResource(id: string): Promise<ResourceCard | null> {
  const store = await loadStore();
  return store.resources.find((resource) => resource.id === id) ?? null;
}

export async function updateResource(
  id: string,
  patch: Partial<Pick<ResourceCard, 'title' | 'tags' | 'parentBoxId' | 'note'>>,
): Promise<ResourceCard | null> {
  const store = await loadStore();
  const idx = store.resources.findIndex((resource) => resource.id === id);
  if (idx === -1) return null;
  const cur = store.resources[idx]!;
  const next: ResourceCard = {
    ...cur,
    title: patch.title !== undefined ? patch.title.trim() || cur.title : cur.title,
    tags: patch.tags !== undefined ? patch.tags.map((tag) => tag.trim()).filter(Boolean) : cur.tags,
    parentBoxId: patch.parentBoxId !== undefined ? (patch.parentBoxId?.trim() || null) : cur.parentBoxId,
    note: patch.note !== undefined ? patch.note.trim() : cur.note,
    updatedAt: new Date().toISOString(),
  };
  store.resources[idx] = next;
  await saveStore(store);
  return next;
}

export async function deleteResource(id: string): Promise<{ resource: ResourceCard; fileDeleted: boolean } | null> {
  const store = await loadStore();
  const idx = store.resources.findIndex((resource) => resource.id === id);
  if (idx === -1) return null;
  const [resource] = store.resources.splice(idx, 1);
  await saveStore(store);
  let fileDeleted = false;
  try {
    await unlink(resolveInside(config.vaultPath, resource!.path));
    fileDeleted = true;
  } catch {
    fileDeleted = false;
  }
  return { resource: resource!, fileDeleted };
}

export async function renameResourceTag(oldName: string, newName: string): Promise<{ updated: number }> {
  const oldTag = oldName.trim().toLowerCase();
  const nextTag = newName.trim().toLowerCase();
  if (!oldTag || !nextTag || oldTag === nextTag) return { updated: 0 };
  const store = await loadStore();
  let updated = 0;
  store.resources = store.resources.map((resource) => {
    if (!resource.tags.some((tag) => tag.toLowerCase() === oldTag)) return resource;
    updated += 1;
    const tags = Array.from(new Set(resource.tags.map((tag) => (tag.toLowerCase() === oldTag ? nextTag : tag))));
    return { ...resource, tags, updatedAt: new Date().toISOString() };
  });
  if (updated > 0) await saveStore(store);
  return { updated };
}

export async function deleteResourceTag(name: string): Promise<{ updated: number }> {
  const target = name.trim().toLowerCase();
  if (!target) return { updated: 0 };
  const store = await loadStore();
  let updated = 0;
  store.resources = store.resources.map((resource) => {
    const tags = resource.tags.filter((tag) => tag.toLowerCase() !== target);
    if (tags.length === resource.tags.length) return resource;
    updated += 1;
    return { ...resource, tags, updatedAt: new Date().toISOString() };
  });
  if (updated > 0) await saveStore(store);
  return { updated };
}

export async function listResourceReferences(repo: CardRepository): Promise<Array<{
  resourceId: string;
  cardId: string;
  cardTitle: string;
}>> {
  const resources = await listResources();
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const refs: Array<{ resourceId: string; cardId: string; cardTitle: string }> = [];
  const seen = new Set<string>();
  for (const card of repo.list()) {
    const matches = card.contentMd.matchAll(/!?\[\[(res_[^\]|]+)(?:\|[^\]]+)?\]\]/g);
    for (const match of matches) {
      const resourceId = match[1]?.trim();
      if (!resourceId || !resourceIds.has(resourceId)) continue;
      const key = `${card.luhmannId}::${resourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ resourceId, cardId: card.luhmannId, cardTitle: card.title });
    }
  }
  return refs;
}

function isResourceKind(kind: unknown): kind is ResourceCard['kind'] {
  return kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video' || kind === 'file';
}

export function inferKindFromPath(path: string): ResourceCard['kind'] {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(lower)) return 'image';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(mp3|wav|m4a|flac|ogg)$/.test(lower)) return 'audio';
  if (/\.(mp4|mov|webm|m4v)$/.test(lower)) return 'video';
  return 'file';
}
