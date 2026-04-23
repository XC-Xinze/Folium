import { useUIStore } from '../store/uiStore';
import { PluginRegistry } from '../lib/pluginRegistry';

export function SettingsView() {
  const setViewMode = useUIStore((s) => s.setViewMode);

  // 内置 + 插件注册的设置面板。MVP 仅渲染内置；插件 SDK V2 接入。
  const panels = PluginRegistry.settingsPanels.list().sort((a, b) => a.order - b.order);

  return (
    <div className="max-w-3xl mx-auto py-10 px-8 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">设置</h1>
        <button
          onClick={() => setViewMode('chain')}
          className="text-[11px] text-gray-500 hover:text-ink"
        >
          ← 返回阅读
        </button>
      </header>

      <section className="border border-gray-200 rounded-lg p-6 bg-white space-y-4">
        <h2 className="text-sm font-bold">General</h2>
        <Field label="Vault 路径" hint="后端启动时通过 VAULT_PATH 环境变量配置">
          <code className="text-[12px] bg-gray-50 px-2 py-1 rounded">{`(env: VAULT_PATH)`}</code>
        </Field>
      </section>

      <section className="border border-gray-200 rounded-lg p-6 bg-white space-y-4">
        <h2 className="text-sm font-bold">Plugins</h2>
        <p className="text-[12px] text-gray-500">
          已注册命令 {PluginRegistry.commands.list().length} 项 · 侧栏面板{' '}
          {PluginRegistry.sidebarItems.list().length} 项 · 设置面板 {panels.length} 项
        </p>
        <p className="text-[11px] text-gray-400">第三方插件加载将在 V2 版本开放。</p>
      </section>

      {panels.map((p) => (
        <section
          key={p.id}
          className="border border-gray-200 rounded-lg p-6 bg-white space-y-4"
        >
          <h2 className="text-sm font-bold">{p.title}</h2>
          <p.Component />
        </section>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-[12px] font-semibold">{label}</div>
        {hint && <div className="text-[11px] text-gray-400">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
