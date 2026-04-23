import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Tag } from 'lucide-react';

export function TagRootNode({ data }: NodeProps) {
  const tag = (data as { tag: string }).tag;
  return (
    <div className="relative px-5 py-3 bg-accent text-white rounded-full shadow-lg flex items-center gap-2 border-2 border-white">
      <Handle id="bottom" type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2 !border-0" />
      <Tag size={14} />
      <span className="text-[14px] font-bold tracking-wide">#{tag}</span>
    </div>
  );
}
