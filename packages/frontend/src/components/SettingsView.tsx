import { useUIStore } from '../store/uiStore';
import { PluginRegistry } from '../lib/pluginRegistry';

export function SettingsView() {
  const setViewMode = useUIStore((s) => s.setViewMode);

  // Built-in + plugin-registered settings panels. MVP renders built-ins only; plugin SDK lands in V2.
  const panels = PluginRegistry.settingsPanels.list().sort((a, b) => a.order - b.order);

  return (
    <div className="max-w-3xl mx-auto py-10 px-8 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Settings</h1>
        <button
          onClick={() => setViewMode('chain')}
          className="text-[11px] text-gray-500 hover:text-ink"
        >
          ← Back to reading
        </button>
      </header>

      <section className="border border-gray-200 rounded-lg p-6 bg-white space-y-4">
        <h2 className="text-sm font-bold">General</h2>
        <Field label="Vault path" hint="Configured via the VAULT_PATH env var when the backend starts">
          <code className="text-[12px] bg-gray-50 px-2 py-1 rounded">{`(env: VAULT_PATH)`}</code>
        </Field>
      </section>

      <section className="border border-gray-200 rounded-lg p-6 bg-white space-y-4">
        <h2 className="text-sm font-bold">Plugins</h2>
        <p className="text-[12px] text-gray-500">
          {PluginRegistry.commands.list().length} commands · {PluginRegistry.sidebarItems.list().length} sidebar items · {panels.length} settings panels
        </p>
        <p className="text-[11px] text-gray-400">Third-party plugin loading lands in V2.</p>
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
