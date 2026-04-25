/**
 * Canvas 自定义 edge 类型：
 *   - PotentialEdge：灰虚线 + 中点 "Link" 按钮 (promote 成 [[link]])
 *   - CrossEdge：紫实线 + 中点 "X" 按钮 (unlink，移除 [[link]])
 *
 * 中点按钮用 EdgeLabelRenderer 绝对定位到 bezier midpoint，跟卡片角按钮不重叠。
 * 默认 opacity 低，hover 在 edge 区附近时高亮。
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, X } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';

function invalidateCrossLinkQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['cards'] });
  qc.invalidateQueries({ queryKey: ['card'] });
  qc.invalidateQueries({ queryKey: ['linked'] });
  qc.invalidateQueries({ queryKey: ['related-batch'] });
  qc.invalidateQueries({ queryKey: ['referenced-from'] });
}

export function PotentialEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data } = props;
  const qc = useQueryClient();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  // workspace-derived edges 端点可能是 ghost id（__ws-temp::xxx）—— 不允许 promote
  // 否则后端 appendCrossLink 找不到那张卡 → 404 popup
  const isWsLink = (data as { isWsLink?: boolean } | undefined)?.isWsLink === true;
  const promoteMut = useMutation({
    mutationFn: () => api.appendCrossLink(source, target),
    onSuccess: () => invalidateCrossLinkQueries(qc),
    onError: (err: Error) => dialog.alert(err.message, { title: 'Promote failed' }),
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      {!isWsLink && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-auto"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (promoteMut.isPending) return;
                promoteMut.mutate();
              }}
              disabled={promoteMut.isPending}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white border border-purple-300 text-purple-600 text-[9px] font-bold shadow-sm hover:bg-purple-500 hover:text-white hover:border-purple-500 transition-colors opacity-60 hover:opacity-100"
              title={`Promote potential to real [[link]]: write [[${target}]] into ${source}`}
            >
              <Link2 size={9} />
              <span>{promoteMut.isPending ? '…' : 'Link'}</span>
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export function CrossEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style } = props;
  const qc = useQueryClient();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const removeMut = useMutation({
    mutationFn: () => api.removeCrossLink(source, target),
    onSuccess: () => invalidateCrossLinkQueries(qc),
    onError: (err: Error) => dialog.alert(err.message, { title: 'Unlink failed' }),
  });
  const onUnlink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (removeMut.isPending) return;
    const ok = await dialog.confirm(
      `Remove [[${target}]] from ${source}?`,
      {
        title: 'Unlink',
        description: '会从 source 卡 body 里移除该 [[link]]。其他卡里对 ' + target + ' 的引用不受影响。',
        confirmLabel: 'Unlink',
        variant: 'danger',
      },
    );
    if (!ok) return;
    removeMut.mutate();
  };
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-auto"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            onClick={onUnlink}
            disabled={removeMut.isPending}
            className="w-4 h-4 rounded-full bg-white border border-purple-300 text-purple-500 hover:bg-red-500 hover:text-white hover:border-red-500 shadow-sm flex items-center justify-center transition-colors opacity-50 hover:opacity-100"
            title={`Unlink: remove [[${target}]] from ${source}`}
          >
            <X size={9} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
