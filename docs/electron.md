# Electron Desktop Shell

The desktop package is a thin Electron shell around the existing local-first app.

## Development

Start the frontend separately:

```bash
npm run dev:frontend
```

Then launch Electron:

```bash
npm run dev:desktop
```

The Electron main process starts the backend on `127.0.0.1:8000` and loads the Vite frontend from `ELECTRON_RENDERER_URL`.

## Production Smoke Run

```bash
npm run start:desktop
```

This builds the frontend and loads `packages/frontend/dist/index.html`.

## Still Missing Before Distribution

- Pack backend runtime cleanly instead of spawning `npm`.
- Add `electron-builder` or Forge packaging.
- Decide app data paths for vault registry, SQLite cache, logs, and crash reports.
- Add auto-update strategy.
- Add code signing/notarization for macOS.
- Add IPC permissions for any desktop-only capabilities instead of exposing Node in the renderer.
