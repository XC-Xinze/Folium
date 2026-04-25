/**
 * 全局撤销栈：删卡、删 workspace 等"破坏性操作"完成后调 pushUndo 注册
 * 反向操作。⌘Z 弹一个出来跑。
 *
 * 当前是会话级（in-memory）。app 关闭就清空。
 */
export interface UndoAction {
  /** 给用户看的人话描述："Deleted card 1a2" */
  description: string;
  /** 反向操作：恢复 / 重建。失败抛错让上层弹 alert */
  undo: () => Promise<void>;
  /** 触发时间戳，超过 N 分钟的会被忽略（防止用户隔天 ⌘Z 把意外的东西恢复出来） */
  timestamp: number;
}

const MAX = 30;
const STALE_MS = 30 * 60 * 1000; // 30 分钟
let stack: UndoAction[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function pushUndo(action: Omit<UndoAction, 'timestamp'>): void {
  stack.push({ ...action, timestamp: Date.now() });
  if (stack.length > MAX) stack = stack.slice(stack.length - MAX);
  notify();
}

export function peekUndo(): UndoAction | null {
  // 跳过 stale
  for (let i = stack.length - 1; i >= 0; i--) {
    const a = stack[i]!;
    if (Date.now() - a.timestamp <= STALE_MS) return a;
  }
  return null;
}

export async function popAndRunUndo(): Promise<UndoAction | null> {
  // 拉最新非 stale 的；过期的就丢
  while (stack.length > 0) {
    const a = stack.pop()!;
    notify();
    if (Date.now() - a.timestamp > STALE_MS) continue;
    await a.undo();
    return a;
  }
  return null;
}

export function clearUndoStack(): void {
  stack = [];
  notify();
}

export function subscribeUndo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function undoStackSize(): number {
  return stack.length;
}
