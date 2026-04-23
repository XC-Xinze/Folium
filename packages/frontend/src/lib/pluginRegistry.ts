import type { ComponentType, ReactNode } from 'react';

/**
 * 前端插件扩展点注册表。
 *
 * MVP 阶段：只搭骨架，内置功能（侧栏面板、设置页 section 等）走注册流程，自我证明 API 可用。
 * V2 阶段：开放给第三方 ES module 动态加载。
 */

export interface CommandSpec {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export interface SidebarItemSpec {
  id: string;
  title: string;
  order: number;
  render: () => ReactNode;
}

export interface SettingsPanelSpec {
  id: string;
  title: string;
  order: number;
  Component: ComponentType;
}

export interface ViewModeSpec {
  id: string;
  title: string;
  Component: ComponentType;
}

class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  register(item: T): void {
    this.items.set(item.id, item);
  }
  unregister(id: string): void {
    this.items.delete(id);
  }
  list(): T[] {
    return [...this.items.values()];
  }
}

export const PluginRegistry = {
  commands: new Registry<CommandSpec>(),
  sidebarItems: new Registry<SidebarItemSpec>(),
  settingsPanels: new Registry<SettingsPanelSpec>(),
  viewModes: new Registry<ViewModeSpec>(),
};

export type PluginRegistryShape = typeof PluginRegistry;
