# Workspace JSON Schema

Workspaces are stored in:

```text
<vault>/.zettel/workspaces.json
```

The file is a map of workspace id to workspace object.

```ts
type WorkspacesFile = Record<string, Workspace>;

interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}
```

## Nodes

```ts
type WorkspaceNode = CardRefNode | TempCardNode | NoteNode;

interface CardRefNode {
  kind: 'card';
  id: string;      // workspace-local node id
  cardId: string;  // real vault luhmannId
  x: number;
  y: number;
}

interface TempCardNode {
  kind: 'temp';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
}

interface NoteNode {
  kind: 'note';
  id: string;
  content: string;
  x: number;
  y: number;
}
```

## Edges

```ts
interface WorkspaceEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  color?: string;
  note?: string;
  applied?: boolean;
  vaultLink?: boolean;
  vaultStructure?: boolean;
  appliedToFile?: string;
  appliedMarker?: string;
  pendingTempIds?: string[];
}
```

See [Workspace Link Model](./workspace-link-model.md) for the meaning of `applied`, `vaultLink`, `vaultStructure`, and temp edge materialization.

## Repair

The backend exposes:

```text
POST /api/workspaces/repair
```

Repair is conservative:

- Normalizes edge state flags.
- Treats legacy `label: "tree"` edges as `vaultStructure`.
- Removes edges whose endpoints no longer exist.
- Removes self-edges created by stale duplicated node ids.
- Merges duplicate `card` nodes with the same `cardId`, remapping edges to the first node.
- Deduplicates exact same source/target/label/handle edges.

Repair does not alter vault card files and does not apply or unapply links.

