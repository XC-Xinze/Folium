import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Tag } from 'lucide-react';
import { api, type PositionMap } from '../lib/api';
import { useUIStore } from '../store/uiStore';
import { usePaneStore } from '../store/paneStore';
import { CardNode } from './CardNode';
import { TagRootNode } from './TagRootNode';
import { applyAnchorPositions, buildTagGraph } from '../lib/cardGraph';
import { dialog } from '../lib/dialog';

const nodeTypes = { card: CardNode, 'tag-root': TagRootNode };

interface Props {
  tag: string;
  paneId: string;
  tabId: string;
}

export function TagView(props: Props) {
  return (
    <ReactFlowProvider>
      <TagViewInner {...props} />
    </ReactFlowProvider>
  );
}

function TagViewInner({ tag, paneId, tabId }: Props) {
  // pane 模式下"返回"没意义 —— 关 tab 即可。把按钮藏起来，免得困惑用户。
  void useUIStore;
  const q = useQuery({ queryKey: ['tag-cards', tag], queryFn: () => api.getCardsByTag(tag) });
  const cardsQ = useQuery({ queryKey: ['cards'], queryFn: api.listCards });
  const qc = useQueryClient();
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const previousCardIdsRef = useRef<string[]>([]);
  const updateTab = usePaneStore((s) => s.updateTab);

  const switchTagInPlace = useCallback((nextTag: string) => {
    updateTab(paneId, tabId, { title: `#${nextTag}`, tagName: nextTag });
    setFocusedCardId(null);
  }, [paneId, tabId, updateTab]);

  const renameCurrentTag = useCallback(async () => {
    const newName = await dialog.prompt(`Rename #${tag} to:`, {
      title: 'Rename tag',
      defaultValue: tag,
      confirmLabel: 'Rename',
    });
    const next = newName?.trim();
    if (!next || next === tag) return;
    try {
      await api.renameTag(tag, next);
      switchTagInPlace(next);
      await Promise.all([
        qc.refetchQueries({ queryKey: ['tags'] }),
        qc.refetchQueries({ queryKey: ['cards'] }),
        qc.refetchQueries({ queryKey: ['card'] }),
        qc.refetchQueries({ queryKey: ['tag-cards'] }),
        qc.refetchQueries({ queryKey: ['related-batch'] }),
      ]);
    } catch (err) {
      void dialog.alert((err as Error).message, { title: 'Rename failed' });
    }
  }, [qc, switchTagInPlace, tag]);

  useEffect(() => {
    const cards = q.data?.cards ?? [];
    if (cards.length > 0) previousCardIdsRef.current = cards.map((card) => card.luhmannId);
  }, [q.data?.cards]);

  useEffect(() => {
    if (!q.data || q.data.cards.length > 0 || !cardsQ.data) return;
    const previousIds = previousCardIdsRef.current;
    if (previousIds.length === 0) return;
    const previousSet = new Set(previousIds);
    const counts = new Map<string, number>();
    for (const card of cardsQ.data.cards) {
      if (!previousSet.has(card.luhmannId)) continue;
      for (const candidate of card.tags) {
        if (candidate === tag) continue;
        counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
      }
    }
    const candidates = [...counts.entries()]
      .filter(([, count]) => count === previousIds.length)
      .sort(([a], [b]) => a.localeCompare(b));
    if (candidates.length !== 1) return;
    switchTagInPlace(candidates[0]![0]);
  }, [cardsQ.data, q.data, switchTagInPlace, tag]);

  const scope = `tag:${tag}`;
  const positionsQ = useQuery({
    queryKey: ['positions', scope],
    queryFn: () => api.getPositions(scope),
  });

  const graph = useMemo(() => {
    if (!q.data?.cards) return { nodes: [] as Node[], edges: [] as Edge[] };
    const raw = buildTagGraph(tag, q.data.cards, focusedCardId);
    const finalNodes = applyAnchorPositions(raw.nodes, raw.edges, positionsQ.data ?? {});
    const cardById = new Map(q.data.cards.map((card) => [card.luhmannId, card]));
    // 把 scope 印到节点 data 上 —— CardNode 用它做位置存储 key
    const stamped = finalNodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as object),
        scope,
        ...(n.id.startsWith('__') ? { onRename: renameCurrentTag } : {}),
        ...(n.id.startsWith('__')
          ? {}
          : {
              onFocusOverride: () => setFocusedCardId(n.id),
              onCardLinkDrop: async (draggedLuhmannId: string) => {
                const targetLuhmannId = n.id;
                if (draggedLuhmannId === targetLuhmannId) return;

                const dragged = cardById.get(draggedLuhmannId);
                const target = cardById.get(targetLuhmannId);
                const alreadyLinked =
                  target?.crossLinks.includes(draggedLuhmannId) ||
                  dragged?.crossLinks.includes(targetLuhmannId);
                if (alreadyLinked) return;

                try {
                  await api.appendCrossLink(targetLuhmannId, draggedLuhmannId);
                  await Promise.all([
                    qc.invalidateQueries({ queryKey: ['tag-cards', tag] }),
                    qc.invalidateQueries({ queryKey: ['card', targetLuhmannId] }),
                    qc.invalidateQueries({ queryKey: ['cards'] }),
                    qc.invalidateQueries({ queryKey: ['linked'] }),
                    qc.invalidateQueries({ queryKey: ['backlinks'] }),
                    qc.invalidateQueries({ queryKey: ['related-batch'] }),
                  ]);
                } catch (err) {
                  void dialog.alert((err as Error).message, { title: 'Link failed' });
                }
              },
            }),
      },
    }));
    return { nodes: stamped, edges: raw.edges };
  }, [tag, q.data, positionsQ.data, scope, qc, focusedCardId, renameCurrentTag]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return graph.nodes.map((n) => {
        const cached = prevPos.get(n.id);
        return cached ? { ...n, position: cached } : n;
      });
    });
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      if (node.id.startsWith('__')) return;
      qc.setQueryData<PositionMap>(['positions', scope], (old = {}) => ({
        ...old,
        [node.id]: { x: node.position.x, y: node.position.y },
      }));
      api.setPosition(scope, node.id, node.position.x, node.position.y).catch((err) => {
        console.error('save position failed', err);
      });
    },
    [qc, scope],
  );

  return (
    <div className="w-full h-full relative bg-surface">
      {/* Top chip — 关闭走 tab 的 X */}
      <div
        className="absolute top-4 left-4 z-10 flex items-center gap-3 bg-white px-3 py-1.5 rounded-lg shadow-md border border-gray-200"
        onDoubleClick={(e) => {
          e.stopPropagation();
          void renameCurrentTag();
        }}
        title="Double-click to rename this tag"
      >
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-accentSoft rounded-full">
          <Tag size={11} className="text-accent" />
          <span className="text-[12px] font-bold text-accent">#{tag}</span>
        </div>
        <span className="text-[11px] text-gray-500">{q.data?.cards.length ?? 0} cards</span>
      </div>

      {q.isLoading && (
        <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
          Loading…
        </div>
      )}
      {q.error && (
        <div className="w-full h-full flex items-center justify-center text-sm text-red-500">
          {String(q.error)}
        </div>
      )}
      {q.data && q.data.cards.length === 0 && (
        <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
          No cards under this tag yet
        </div>
      )}

      {q.data && q.data.cards.length > 0 && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1, minZoom: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background id={`tag-bg-${tag}`} gap={24} size={1.5} color="#e5e7eb" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap pannable zoomable position="top-right" maskColor="rgba(0,0,0,0.05)" />
        </ReactFlow>
      )}
    </div>
  );
}
