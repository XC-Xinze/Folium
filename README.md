<p align="center">
  <img src="docs/assets/folium-logo.png" alt="Folium logo" width="128" height="128" />
</p>

<h1 align="center">Folium</h1>

<p align="center">
  A local-first card workspace for thinking through links, boxes, and temporary canvases.
</p>

<p align="center">
  <a href="https://xc-xinze.github.io/Folium/">Website</a>
  ·
  <a href="https://xc-xinze.github.io/Folium/documentation.html">Documentation</a>
  ·
  <a href="docs/plugin-sdk-v0.md">Plugin SDK</a>
  ·
  <a href="docs/electron.md">Desktop Notes</a>
</p>

---

Folium is a desktop-first Markdown knowledge workspace inspired by the useful parts of Obsidian, Logseq, and Luhmann-style card indexes, but built around a different premise:

> Links should carry a chain of thought, not just decorate isolated notes.

Your notes stay as plain Markdown files in a local vault. Folium builds a local SQLite index over those files, then gives you card boxes, real double-links, potential links, graph exploration, tag views, temporary workspaces, attachment handling, and a trusted local plugin surface.

## 1.5 Release

Folium 1.5 is the first version that feels like the intended product rather than a pile of useful experiments.

- **Simpler card canvas**: the main box view now focuses on box structure, real links, and optional potential links.
- **Correct link expansion**: cards in the current box can pull in directly linked external cards, but imported external cards do not recursively pull a second ring.
- **Potential as helper layer**: potential links combine unlinked references with high-confidence similarity signals while filtering attachment noise, date fragments, and generic daily-note terms.
- **Workspace cleanup**: temp cards, real cards, labels, notes, apply/unapply behavior, and deletion fallbacks now follow a clearer model.
- **Graph view cleanup**: graph filters are now `Box`, `Link`, and `Tag`; the old hierarchy filter was removed because it was not a user-facing business concept.
- **Visual redesign**: paper-like surfaces, calmer typography, dark mode fixes, focus styling, better card creation panels, and a more coherent GraphView.
- **Layout preservation**: user-placed card positions are saved per box/workspace, with reset layout available when needed.
- **Image export**: box canvases and workspaces can export the current visible canvas as a PNG with clean solid links.
- **Plugin path**: the early trusted-local plugin SDK is documented for future import/export and workflow extensions.

## 1.0 vs 1.5

Folium 1.0 was the first public baseline: local vaults, Electron packaging, card canvases, workspaces, graph view, attachments, backups, and plugin groundwork were already present.

Folium 1.5 is a product-shaping release. The biggest change is not one feature; it is the removal of confusing behavior. The main canvas no longer tries to be every view at once. Workspaces are clearly provisional. GraphView is for global structure. Potential links are suggestions, not structure. This makes 1.5 a better default for real use, while 1.0 remains useful as a reference point for anyone who wants to study or fork the earlier, heavier interaction model.

## Core Ideas

- **Box**: a top-level numbered card such as `1`, `2`, or `3` acts as an index box. Its Folgezettel descendants belong to that box.
- **Card**: a Markdown note with a stable `luhmannId`.
- **Real link**: a deliberate `[[link]]` stored in the vault.
- **Potential link**: an unconfirmed suggestion from naked text references or high-confidence local similarity.
- **Workspace**: a temporary canvas for arranging cards, notes, and temp cards before committing relationships back to the vault.
- **Graph**: a global map of Box, Link, and Tag relations.

## Highlights

- **Local-first Markdown**: ordinary `.md` files remain the source of truth.
- **SQLite index**: the database is an index, not a proprietary storage format.
- **Persistent layouts**: card positions survive reloads per box and per workspace.
- **Real and provisional links**: distinguish durable vault links from workspace-only reasoning.
- **Temp cards**: sketch ideas in a workspace, then promote them into the vault when they are ready.
- **Tag views**: collect tag-related cards and create real links from that context.
- **Graph focus mode**: hover or select a node to emphasize first-degree relations.
- **Canvas PNG export**: export a box or workspace as an image for sharing or documentation.
- **Trusted local plugins**: plugin APIs are intentionally local and trusted, similar in spirit to Obsidian community plugins.

## Install

Folium 1.5 currently targets macOS Apple Silicon for local packaged builds.

```bash
npm install
npm run pack:desktop
open release/mac-arm64/Folium.app
```

The app is not code-signed yet. On macOS, first launch may require right-click -> Open or approval in System Settings.

You can also run the web frontend and backend during development:

```bash
npm install

# Terminal 1
npm run dev:backend

# Terminal 2
npm run dev:frontend
```

Open:

```text
http://127.0.0.1:5173
```

Desktop development:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:desktop
```

## Project Structure

```text
Folium/
├── packages/
│   ├── backend/      Fastify API, SQLite index, vault scanner, watcher
│   ├── frontend/     React, Vite, Tailwind, card/workspace/graph UI
│   └── desktop/      Electron shell and preload bridge
├── docs/             GitHub Pages, method docs, plugin notes
└── example-vault/    Development sample vault
```

## Card Format

```markdown
---
luhmannId: 1a
title: Feature Selection and Dimensionality
tags: [ML, Research]
crossLinks: [1a1, 3b]
---

Body text can include [[1a1]] or [[Card Title]] links.
```

`status` is derived by the app. Top-level numbered cards and cards with Folgezettel children are treated as index cards.

## Security Model

Folium is designed as a local desktop app.

- The packaged backend binds to `127.0.0.1`.
- Packaged API requests require an Electron-provided per-run token.
- Vault file routes and backup restore paths are guarded against traversal and zip-slip.
- Attachments live inside the selected vault root.
- Plugins use a **trusted local plugin** model. They are not a hard sandbox.

## Documentation

- [Using Folium and Luhmann-style cards](https://xc-xinze.github.io/Folium/documentation.html)
- [Plugin SDK v0](docs/plugin-sdk-v0.md)
- [Workspace link model](docs/workspace-link-model.md)
- [Workspace JSON schema](docs/workspace-json-schema.md)
- [Electron packaging notes](docs/electron.md)

## Roadmap

- Signed and notarized macOS builds.
- Release artifacts through GitHub Releases.
- Plugin SDK stabilization.
- Obsidian export plugin as the first official plugin example.
- Windows/Linux packaging.
- Mobile-friendly architecture after the desktop workflow settles.

## License

No license has been selected yet. Treat the repository as source-available until a license is added.
