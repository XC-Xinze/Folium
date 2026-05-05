# Folium Local AI API

Folium exposes a local REST API for trusted automation and AI tools.

Scope:

- Search, read, create, update, delete, reparent, and link cards.
- Manage workspaces and temporary workspace-to-vault promotion.
- Export Markdown or generated plugin bundles.
- Upload and inspect attachments.

Security model:

- The backend binds to `127.0.0.1` by default.
- Packaged desktop builds require `X-Folium-Token`.
- The token is generated per app run and is available inside `Settings -> AI / Local API`.
- Do not bind Folium to `0.0.0.0` for AI integrations.
- Treat AI tools as trusted local clients. They can modify your Markdown vault.

Base URL:

```txt
http://127.0.0.1:<port>/api
```

Packaged desktop auth header:

```http
X-Folium-Token: <token copied from Settings>
```

Core card endpoints:

```http
GET    /cards
GET    /cards/:id
POST   /cards
PATCH  /cards/:id
DELETE /cards/:id
GET    /search?q=term&limit=20
POST   /cards/:id/append-link
POST   /cards/:id/remove-link
POST   /cards/reparent
POST   /cards/next-child-id
GET    /cards/:id/potential
GET    /cards/:id/referenced-from
```

Create a card:

```bash
curl -X POST "$FOLIUM_API/cards" \
  -H "Content-Type: application/json" \
  -H "X-Folium-Token: $FOLIUM_TOKEN" \
  -d '{
    "luhmannId": "3a",
    "title": "New thought",
    "content": "# New thought\n\nBody text",
    "tags": ["draft"],
    "crossLinks": ["1a"]
  }'
```

Update a card:

```bash
curl -X PATCH "$FOLIUM_API/cards/3a" \
  -H "Content-Type: application/json" \
  -H "X-Folium-Token: $FOLIUM_TOKEN" \
  -d '{
    "title": "Updated thought",
    "content": "# Updated thought\n\nRewritten body.",
    "tags": ["processed"]
  }'
```

Append a real double-link:

```bash
curl -X POST "$FOLIUM_API/cards/3a/append-link" \
  -H "Content-Type: application/json" \
  -H "X-Folium-Token: $FOLIUM_TOKEN" \
  -d '{ "targetId": "1a" }'
```

Reparent and renumber a subtree:

```bash
curl -X POST "$FOLIUM_API/cards/reparent" \
  -H "Content-Type: application/json" \
  -H "X-Folium-Token: $FOLIUM_TOKEN" \
  -d '{ "sourceId": "3a", "newParentId": "2", "dryRun": true }'
```

Workspace endpoints:

```http
GET    /workspaces
POST   /workspaces
GET    /workspaces/:id
PUT    /workspaces/:id
DELETE /workspaces/:id
POST   /workspaces/:id/apply-edge
POST   /workspaces/:id/unapply-edge
POST   /workspaces/:id/temp-to-vault
POST   /workspace-links/batch
```

Recommended AI workflow:

1. Search with `/search`.
2. Read full cards with `/cards/:id`.
3. Ask the user before destructive edits.
4. Use `PATCH /cards/:id` for targeted changes.
5. Use `POST /cards/:id/append-link` for confirmed links.
6. Use `POST /cards/reparent` with `dryRun: true` before renumbering.
7. Trigger a backup from the app before large automated changes.

For in-app plugins, prefer the TypeScript-facing SDK documented in `docs/plugin-sdk-v0.md`.
