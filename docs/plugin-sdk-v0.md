# Plugin SDK v0

Plugins are ES modules stored in:

```text
<vault>/.zettel/plugins/*.js
```

Each plugin exports `activate(ctx)` or a default function:

```js
export default function activate(ctx) {
  const cleanup = ctx.sdk.commands.register({
    id: 'my-plugin.hello',
    title: 'My Plugin: hello',
    group: 'Plugins',
    run: () => ctx.sdk.ui.alert('Hello'),
  });

  return { deactivate: cleanup };
}
```

## Context

Prefer `ctx.sdk`. Direct `ctx.api`, `ctx.registry`, and `ctx.commands` still exist for early plugins, but are compatibility shims and may be narrowed.

### `ctx.sdk.cards`

- `list()`
- `get(id)`
- `create({ luhmannId, title, content, tags, crossLinks })`
- `update(id, { title, content, tags })`
- `search(q, limit)`
- `star(id)`
- `unstar(id)`

### `ctx.sdk.workspaces`

- `list()`
- `get(id)`
- `create(name)`
- `update(id, patch)`
- `addCards(workspaceId, cardIds)` adds real vault-card references, skipping duplicates.
- `addEdge(workspaceId, sourceCardId, targetCardId, { label, note, color })` creates a workspace draft edge between real cards, adding missing card nodes first.
- `updateEdgeMeta(workspaceId, edgeId, { label, note, color })`

Workspace edge state follows [Workspace Link Model](./workspace-link-model.md). Plugins should treat `vaultLink` and `vaultStructure` edges as read-only mirrors of vault state.

Example:

```js
export default function activate(ctx) {
  return ctx.sdk.commands.register({
    id: 'example.workspace-link',
    title: 'Example: add workspace relation',
    group: 'Plugins',
    run: async () => {
      const [ws] = await ctx.sdk.workspaces.list();
      if (!ws) return ctx.sdk.ui.alert('No workspace exists');
      await ctx.sdk.workspaces.addEdge(ws.id, '1', '2', {
        label: 'related',
        note: 'Created by a plugin',
        color: '#10b981',
      });
    },
  });
}
```

### `ctx.sdk.ui`

- `openCard(id, { newTab })`
- `openGraph({ newTab })`
- `openSettings({ newTab })`
- `alert(message, { title })`

### `ctx.sdk.commands`

- `register(command)` returns a cleanup function.

### `ctx.sdk.storage`

Namespaced per plugin in `localStorage`.

- `get(key, fallback)`
- `set(key, value)`
- `remove(key)`

## Missing Before Public Plugins

- Manifest: id, version, app compatibility, permissions, mobile support.
- Permission checks: cards read/write/delete, workspace, vault files, network, system open.
- Plugin lifecycle on vault switch and hot reload.
- UI extension points for card menus, card toolbar, canvas nodes, markdown render hooks, ribbon/status bar.
- Backend plugin hooks for indexing and file transforms.
