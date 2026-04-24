import { Moon, Sun, Monitor } from 'lucide-react';
import { useUIStore, type Theme } from '../store/uiStore';
import { PluginRegistry } from '../lib/pluginRegistry';
import { HotkeysPanel } from './HotkeysPanel';
import { TrashPanel } from './TrashPanel';

export function SettingsView() {
  const setViewMode = useUIStore((s) => s.setViewMode);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const panels = PluginRegistry.settingsPanels.list().sort((a, b) => a.order - b.order);

  return (
    <div className="max-w-3xl mx-auto py-10 px-8 space-y-8 text-ink dark:text-gray-200">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Settings</h1>
        <button
          onClick={() => setViewMode('chain')}
          className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
        >
          ← Back to reading
        </button>
      </header>

      <Section title="Appearance">
        <Field label="Theme" hint="Light, dark, or follow your system preference">
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full p-1">
            {([
              ['light', <Sun key="s" size={12} />, 'Light'],
              ['dark', <Moon key="m" size={12} />, 'Dark'],
              ['auto', <Monitor key="a" size={12} />, 'Auto'],
            ] as Array<[Theme, JSX.Element, string]>).map(([value, icon, label]) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${
                  theme === value
                    ? 'bg-white dark:bg-gray-700 text-ink dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-200'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="General">
        <Field label="Vault path" hint="Configured via the VAULT_PATH env var when the backend starts">
          <code className="text-[12px] bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded">{`(env: VAULT_PATH)`}</code>
        </Field>
      </Section>

      <Section title="Hotkeys">
        <HotkeysPanel />
      </Section>

      <Section title="Trash">
        <TrashPanel />
      </Section>

      <Section title="Plugins">
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {PluginRegistry.commands.list().length} commands · {PluginRegistry.sidebarItems.list().length} sidebar items · {panels.length} settings panels
        </p>
        <p className="text-[11px] text-gray-400 dark:text-gray-500">Third-party plugin loading lands in V2.</p>
      </Section>

      {panels.map((p) => (
        <Section key={p.id} title={p.title}>
          <p.Component />
        </Section>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-gray-200 dark:border-[#363a4f] rounded-lg p-6 bg-white dark:bg-[#1e2030] space-y-4">
      <h2 className="text-sm font-bold">{title}</h2>
      {children}
    </section>
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
        {hint && <div className="text-[11px] text-gray-400 dark:text-gray-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
