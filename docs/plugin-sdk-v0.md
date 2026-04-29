# Plugin SDK v0

Plugins are ES modules stored in:

```text
<vault>/.zettel/plugins/*.js
```

Each plugin exports `activate(ctx)` or a default function:

```js
export const manifest = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '0.1.0',
  minAppVersion: '0.0.1',
  mobile: true,
};

export default function activate(ctx) {
  ctx.sdk.commands.register({
    id: 'my-plugin.hello',
    title: 'My Plugin: hello',
    group: 'Plugins',
    run: () => ctx.sdk.ui.alert('Hello'),
  });
}
```

## Context

Prefer `ctx.sdk`. Direct `ctx.api`, `ctx.registry`, and `ctx.commands` still exist for early plugins, but are compatibility shims and may be narrowed.

Plugins may export `manifest`. It is optional in v0, but public plugins should include `id`, `name`, `version`, `minAppVersion`, and `mobile`.

The SDK tracks disposables for `ctx.sdk.commands.register(...)`; commands are automatically unregistered on plugin reload even if the plugin does not return a `deactivate` cleanup. Plugins can still return `{ deactivate() {} }` for their own timers, DOM listeners, or other resources.

## Manifest

`manifest` is optional while the SDK is v0, but every shareable plugin should export it:

```js
export const manifest = {
  id: 'author.plugin-id',
  name: 'Readable Plugin Name',
  version: '0.1.0',
  minAppVersion: '0.0.1',
  mobile: true,
};
```

- `id`: stable identifier. Use reverse-domain or `author.plugin` style.
- `name`: display name.
- `version`: plugin version.
- `minAppVersion`: oldest app version known to work.
- `mobile`: whether the plugin avoids desktop-only assumptions.

There is no permission manifest yet. Treat installed plugins as trusted code.

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
- `addEdge(workspaceId, sourceCardId, targetCardId, { label, note, color })` creates a workspace draft edge between real cards, adding missing card nodes first. Edges are treated as one logical undirected relation for duplicate prevention, so `A -> B` and `B -> A` will not both be added.
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
- `openWorkspace(id, { newTab })`
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

- Permission checks: cards read/write/delete, workspace, vault files, network, system open.
- Manifest-level capability declarations and install-time warnings.
- Plugin lifecycle on vault switch and hot reload beyond the current reload cleanup.
- Stable UI extension points for card menus, card toolbar, canvas nodes, markdown render hooks, ribbon/status bar.
- Backend plugin hooks for indexing, file transforms, import/export, and search providers.
- Versioned SDK compatibility tests and example plugins.
