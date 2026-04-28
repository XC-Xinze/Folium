# Workspace Link Model

Workspace edges are relationship drafts or relationship mirrors. Their UI badge is derived from the endpoints plus a small set of persisted flags.

## States

| Badge | Meaning | Apply behavior |
| --- | --- | --- |
| `双链` | A draft link between two real vault cards. | Can be applied to the vault as a real `[[link]]`. |
| `applied` | A workspace draft edge that has already been written to the vault. | Can be unapplied because the workspace owns the inserted link marker. |
| `vault` | A real `[[link]]` that already existed in the vault before entering the workspace. | Read-only in workspace; not owned by the workspace edge. |
| `tree` | A Folgezettel parent/child structure relation. | Read-only; structure is controlled by card ids/reparenting. |
| `temp` | An edge involving a temp card. | Materializes when the temp card is promoted to a vault card. |
| `workspace` | An edge involving a note or other workspace-only object. | Workspace-only. |

## Edge Fields

- `applied`: the edge was written to the vault by workspace `Apply`.
- `vaultLink`: the edge mirrors an existing vault `[[link]]`.
- `vaultStructure`: the edge mirrors vault structure, usually imported from `tree` graph edges.
- `label`: user-facing relationship label. If present, the badge displays it while keeping the state styling.
- `note`: workspace-only explanation for why the relationship exists.
- `color`: workspace-only edge stroke override.

## Rules

- Only real-card to real-card draft edges can be applied.
- `vault`, `tree`, and `applied` are visually distinct to avoid repeat-apply mistakes.
- Deleting a `vault` or `tree` edge from a workspace only removes the workspace edge.
- Deleting an `applied` edge also unapplies the vault marker first.
- Temp edges are not manually applied; promotion handles materialization.

## Normalization

The backend normalizes workspace edges on read/write:

- `applied`, `vaultLink`, and `vaultStructure` are coerced to booleans.
- Legacy edges with `label: "tree"` are treated as `vaultStructure: true`.
- Plugin and UI code should prefer explicit flags when creating new edges.

## Plugin Guidance

Use `ctx.sdk.workspaces.addEdge(workspaceId, sourceCardId, targetCardId, { label, note, color })` for a new draft double-link between real cards. Do not manually set `applied`, `vaultLink`, or `vaultStructure` from plugins unless the plugin is deliberately mirroring existing vault state.
