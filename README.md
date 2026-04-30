<p align="center">
  <img src="docs/assets/folium-logo.png" alt="Folium logo" width="128" height="128" />
</p>

<h1 align="center">Folium</h1>

<p align="center">
  A local-first card workspace for thinking in links, sequences, and living context.
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

Folium is a desktop-first Markdown knowledge workspace inspired by the good parts of Obsidian, Logseq, and Luhmann's Zettelkasten, but built around a different premise:

> Links should help carry a chain of thought, not just decorate isolated notes.

Cards are stored as plain Markdown files in a vault. Folium builds a local SQLite index over them, then gives you a chain view, workspace canvases, graph exploration, tags, backlinks, potential links, and temporary workspace cards that can later become real vault cards.

## Highlights

- **Local-first Markdown vaults**: your notes remain ordinary `.md` files.
- **Chain reading**: click through links and keep the thinking path visible.
- **Workspace canvases**: pull cards into a temporary thinking space, connect them, annotate links, and apply real links back to the vault when ready.
- **Graph view**: a calm visual map with focus behavior for related cards and links.
- **Potential links**: discover unlinked relationships without requiring an LLM.
- **Tags and box filters**: filter links by manual links, tags, potential links, workspace links, and cards in the current index.
- **Attachments and backups**: local attachment handling, PDF/open-in-system support, and vault backups.
- **Plugin-ready architecture**: trusted local plugins can extend commands and UI through the early SDK.
- **Desktop packaging**: Electron shell with an embedded local Fastify backend.

## Screenshots

The app is still moving quickly, so screenshots are best viewed on the project website:

https://xc-xinze.github.io/Folium/

## Install

Folium 1.0 currently targets macOS Apple Silicon for the local packaged build.

```bash
npm install
npm run pack:desktop
open release/mac-arm64/Folium.app
```

The app is not code-signed yet. On macOS, the first launch may require allowing it from System Settings or using right-click -> Open.

## Development

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
│   ├── frontend/     React, Vite, Tailwind, graph/workspace/card UI
│   └── desktop/      Electron shell and preload bridge
├── docs/             GitHub Pages, plugin notes, workspace model docs
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

`status` is derived by the app. Top-level numbered cards and cards with children are treated as index cards.

## Security Model

Folium is designed as a local desktop app.

- The packaged backend binds to `127.0.0.1`.
- Packaged API requests require an Electron-provided per-run token.
- Vault file routes and backup restore paths are guarded against traversal and zip-slip.
- Plugins are currently a **trusted local plugin** model, similar in spirit to Obsidian community plugins. They are not a hard sandbox.

## Roadmap

- Signed and notarized macOS builds.
- Release artifacts through GitHub Releases.
- Plugin SDK stabilization.
- More graph/workspace export options.
- Windows/Linux packaging.
- Mobile-friendly architecture after the desktop workflow settles.

## License

No license has been selected yet. Treat the repository as source-available until a license is added.
