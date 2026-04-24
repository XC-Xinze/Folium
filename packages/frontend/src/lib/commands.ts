/**
 * 命令系统：把全局快捷键集中起来，配上可重映射的设置面板。
 *
 * - Command 注册：name + 默认快捷键 + 处理函数
 * - 用户在 Settings 里可以改快捷键，覆盖存到 uiStore
 * - 一个全局 keydown handler 解析事件 → 找匹配的命令 → 执行
 *
 * 注意：input/textarea/contentEditable 内不响应（除非命令明确 allowInInput）。
 */

import { useEffect } from 'react';
import { useUIStore } from '../store/uiStore';

export interface Command {
  /** 唯一 id，存设置时用 */
  id: string;
  /** 用户可见的描述 */
  title: string;
  /** 默认快捷键，如 "Mod+K"（Mod = ⌘ on Mac, Ctrl on Win/Linux） */
  defaultShortcut?: string;
  /** 命令分组，用于 Settings 里分类 */
  group?: string;
  /** 是否允许在输入框里触发；默认 false */
  allowInInput?: boolean;
  /** 实际执行 */
  run: () => void;
}

export interface ParsedShortcut {
  mod: boolean; // Cmd on Mac, Ctrl elsewhere
  ctrl: boolean; // 显式 Control（不映射到 Cmd）
  alt: boolean;
  shift: boolean;
  key: string; // 小写
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** 把 "Mod+Shift+K" 这种字符串 parse 成结构化数据 */
export function parseShortcut(str: string): ParsedShortcut | null {
  if (!str) return null;
  const parts = str.split('+').map((s) => s.trim());
  const mods = { mod: false, ctrl: false, alt: false, shift: false };
  let key = '';
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === '⌘') mods.mod = true;
    else if (lower === 'ctrl' || lower === 'control') mods.ctrl = true;
    else if (lower === 'alt' || lower === 'option' || lower === '⌥') mods.alt = true;
    else if (lower === 'shift' || lower === '⇧') mods.shift = true;
    else key = lower;
  }
  if (!key) return null;
  return { ...mods, key };
}

/** 给用户看的：Mod 在 Mac 显示 ⌘，其他显示 Ctrl */
export function formatShortcut(str: string): string {
  const p = parseShortcut(str);
  if (!p) return '';
  const parts: string[] = [];
  if (p.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (p.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(p.key.length === 1 ? p.key.toUpperCase() : p.key);
  return parts.join(isMac ? '' : '+');
}

/** 检查 KeyboardEvent 是否匹配 ParsedShortcut */
export function matchEvent(e: KeyboardEvent, p: ParsedShortcut): boolean {
  // Mod = Cmd on Mac, Ctrl elsewhere
  const expectedMod = p.mod && (isMac ? e.metaKey : e.ctrlKey);
  const noModExpected = !p.mod;
  const modOk = expectedMod || (noModExpected && (isMac ? !e.metaKey : !e.ctrlKey));
  // 显式 Ctrl（独立于 Mod）
  if (p.ctrl && !e.ctrlKey) return false;
  if (!p.ctrl && p.mod && !isMac && !e.ctrlKey) return false; // Mod 在非 Mac = Ctrl
  if (!modOk) return false;
  if (p.alt !== e.altKey) return false;
  if (p.shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === p.key;
}

/** 命令注册表（运行时填）。模块单例。 */
const commands = new Map<string, Command>();
let listenerCount = 0;
let listener: ((e: KeyboardEvent) => void) | null = null;

export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd);
  return () => commands.delete(cmd.id);
}

export function listCommands(): Command[] {
  return [...commands.values()];
}

/**
 * 全局 keydown handler 的安装钩子。整个 app 调用一次。
 * 事件优先级：当前 shortcutOverrides[id] > command.defaultShortcut。
 */
export function useGlobalCommands(): void {
  const overrides = useUIStore((s) => s.shortcutOverrides);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 在输入框里不要捕获（除非命令明确允许）
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      for (const cmd of commands.values()) {
        if (inInput && !cmd.allowInInput) continue;
        const sc = overrides[cmd.id] ?? cmd.defaultShortcut;
        const parsed = sc ? parseShortcut(sc) : null;
        if (!parsed) continue;
        if (matchEvent(e, parsed)) {
          e.preventDefault();
          cmd.run();
          return;
        }
      }
    };
    if (listenerCount === 0) {
      listener = handler;
      window.addEventListener('keydown', handler);
    } else {
      // 多次挂载只装第一个
      window.removeEventListener('keydown', listener!);
      listener = handler;
      window.addEventListener('keydown', handler);
    }
    listenerCount += 1;
    return () => {
      listenerCount -= 1;
      if (listenerCount === 0 && listener) {
        window.removeEventListener('keydown', listener);
        listener = null;
      }
    };
  }, [overrides]);
}

/**
 * 在 keydown 事件里"录制"快捷键 → 返回 "Mod+Shift+K" 格式。
 * 用户按 Esc 表示取消、按 Backspace 表示清空。
 */
export function captureShortcut(e: KeyboardEvent): string | null | 'cancel' | 'clear' {
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Backspace') return 'clear';
  // 单纯按 modifier 不算
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return parts.join('+');
}
