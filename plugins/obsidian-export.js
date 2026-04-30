export const manifest = {
  id: 'folium.export.obsidian',
  name: 'Obsidian Export',
  version: '0.1.0',
  minAppVersion: '1.0.0',
  mobile: false,
};

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function yamlList(values) {
  const clean = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (clean.length === 0) return '[]';
  return `\n${clean.map((value) => `  - ${yamlScalar(value)}`).join('\n')}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWikilinkTo(markdown, id, title) {
  const targets = [id, title].filter(Boolean).map(escapeRegExp);
  if (targets.length === 0) return false;
  return new RegExp(String.raw`\[\[\s*(?:${targets.join('|')})\s*(?:\||\]\])`, 'i').test(markdown);
}

function obsidianLink(card) {
  if (!card) return '';
  if (!card.title || card.title === card.luhmannId) return `[[${card.luhmannId}]]`;
  return `[[${card.luhmannId}|${card.title}]]`;
}

function safeSegment(value, fallback = 'untitled') {
  const clean = String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '')
    .slice(0, 80);
  return clean || fallback;
}

function cardToMarkdown(card, cardsById) {
  const aliases = card.title && card.title !== card.luhmannId ? [card.title] : [];
  const fm = [
    '---',
    `title: ${yamlScalar(card.title)}`,
    `aliases: ${yamlList(aliases)}`,
    `tags: ${yamlList(card.tags ?? [])}`,
    `folium_id: ${yamlScalar(card.luhmannId)}`,
    card.createdAt ? `created: ${yamlScalar(card.createdAt)}` : '',
    card.updatedAt ? `updated: ${yamlScalar(card.updatedAt)}` : '',
    '---',
    '',
  ].filter((line) => line !== '').join('\n');

  const body = String(card.contentMd ?? '').trimEnd();
  const related = [...new Set(card.crossLinks ?? [])]
    .map((id) => cardsById.get(id))
    .filter((target) => target && target.luhmannId !== card.luhmannId)
    .filter((target) => !hasWikilinkTo(body, target.luhmannId, target.title))
    .map((target) => `- ${obsidianLink(target)}`);

  if (related.length === 0) return `${fm}${body}\n`;
  return `${fm}${body}\n\n## Folium Links\n\n${related.join('\n')}\n`;
}

function workspaceToCanvas(workspace) {
  const nodes = workspace.nodes.map((node) => {
    const base = {
      id: node.id,
      x: Math.round(node.x ?? 0),
      y: Math.round(node.y ?? 0),
      width: Math.round(node.w ?? 360),
      height: Math.round(node.h ?? 240),
    };
    if (node.kind === 'card') {
      return { ...base, type: 'file', file: `${safeSegment(node.cardId)}.md` };
    }
    return {
      ...base,
      type: 'text',
      text: node.kind === 'temp' ? `# ${node.title}\n\n${node.content ?? ''}` : node.content ?? '',
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = workspace.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target,
      label: edge.label || undefined,
      color: edge.color || undefined,
    }));

  return JSON.stringify({ nodes, edges }, null, 2);
}

export default function activate(ctx) {
  return ctx.sdk.commands.register({
    id: 'folium.export.obsidian',
    title: 'Export: Obsidian-compatible vault',
    group: 'Plugins',
    run: async () => {
      const summaries = await ctx.sdk.cards.list();
      const cards = await Promise.all(summaries.map((card) => ctx.sdk.cards.get(card.luhmannId)));
      const cardsById = new Map(cards.map((card) => [card.luhmannId, card]));
      const workspaces = await ctx.sdk.workspaces.list();

      const files = cards.map((card) => ({
        path: `${safeSegment(card.luhmannId)}.md`,
        content: cardToMarkdown(card, cardsById),
      }));

      for (const workspace of workspaces) {
        files.push({
          path: `Workspaces/${safeSegment(workspace.name, workspace.id)}.canvas`,
          content: workspaceToCanvas(workspace),
        });
      }

      files.push({
        path: 'README-Folium-Export.md',
        content:
          '# Folium export for Obsidian\n\n' +
          '- Card files keep Folium ids as filenames so existing `[[1a]]` links still work.\n' +
          '- Card titles are written as Obsidian aliases.\n' +
          '- Folium workspace canvases are exported to `Workspaces/*.canvas`.\n' +
          '- Attachments are copied into `attachments/` when present.\n',
      });

      await ctx.sdk.export.downloadZip({
        fileName: 'folium-obsidian-export.zip',
        files,
        includeAttachments: true,
      });
      await ctx.sdk.ui.alert(`Exported ${cards.length} cards and ${workspaces.length} workspace canvas file(s).`, {
        title: 'Obsidian export',
      });
    },
  });
}
