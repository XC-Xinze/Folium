import { EventEmitter } from 'node:events';
import type { Card } from './types.js';

type HookEvents = {
  'card:beforeSave': (card: Card) => void | Promise<void>;
  'card:afterSave': (card: Card) => void | Promise<void>;
  'card:beforeDelete': (luhmannId: string) => void | Promise<void>;
  'card:parsed': (card: Card) => void | Promise<void>;
  'vault:scanned': (info: { count: number; durationMs: number }) => void | Promise<void>;
  'link:resolve': (raw: string) => string | null;
};

class HookBus extends EventEmitter {
  on<K extends keyof HookEvents>(event: K, listener: HookEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof HookEvents>(event: K, ...args: Parameters<HookEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

export const hooks = new HookBus();
