import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, Monitor, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { useUIStore, type Theme } from '../store/uiStore';
import { api } from '../lib/api';
import { PluginRegistry } from '../lib/pluginRegistry';
import { listLoadedPlugins, reloadPlugins, type LoadedPlugin } from '../lib/pluginLoader';
import { HotkeysPanel } from './HotkeysPanel';
import { TrashPanel } from './TrashPanel';
import { SearchReplacePanel } from './SearchReplacePanel';
import { ExportPanel } from './ExportPanel';
import { DiscoveriesPanel } from './DiscoveriesPanel';

export function SettingsView() {
  // 在 modal 模式下，"返回"只需要关弹窗；其他场景由模态外层处理
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const panels = PluginRegistry.settingsPanels.list().sort((a, b) => a.order - b.order);

  return (
    <div className="max-w-3xl mx-auto py-10 px-8 space-y-8 text-ink dark:text-gray-200">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Settings</h1>
        <button
          onClick={() => setSettingsOpen(false)}
          className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
        >
          Close
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

      <Section title="Attachments">
        <AttachmentPolicyField />
      </Section>

      <Section title="Hotkeys">
        <HotkeysPanel />
      </Section>

      <Section title="Discoveries">
        <DiscoveriesPanel />
      </Section>

      <Section title="Search & Replace">
        <SearchReplacePanel />
      </Section>

      <Section title="Export">
        <ExportPanel />
      </Section>

      <Section title="Trash">
        <TrashPanel />
      </Section>

      <Section title="Plugins">
        <PluginsPanel />
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          {PluginRegistry.commands.list().length} commands · {PluginRegistry.sidebarItems.list().length} sidebar items · {panels.length} settings panels registered
        </p>
      </Section>

      {panels.map((p) => (
        <Section key={p.id} title={p.title}>
          <p.Component />
        </Section>
      ))}
    </div>
  );
}

function PluginsPanel() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>(() => listLoadedPlugins());
  const [reloading, setReloading] = useState(false);
  // 切回这个面板时刷一下显示（启动加载可能还没完）
  useEffect(() => {
    setPlugins(listLoadedPlugins());
  }, []);
  const onReload = async () => {
    setReloading(true);
    try {
      const next = await reloadPlugins();
      setPlugins(next);
    } finally {
      setReloading(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          Drop <code className="text-[11px] px-1 rounded bg-gray-100 dark:bg-gray-800">.js</code> files into{' '}
          <code className="text-[11px] px-1 rounded bg-gray-100 dark:bg-gray-800">~/your-vault/.zettel/plugins/</code> and reload.
        </p>
        <button
          onClick={onReload}
          disabled={reloading}
          className="text-[11px] font-bold flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
        >
          <RefreshCw size={11} className={reloading ? 'animate-spin' : ''} />
          Reload
        </button>
      </div>
      {plugins.length === 0 ? (
        <p className="text-[11px] text-gray-400">No plugins loaded.</p>
      ) : (
        <ul className="space-y-1">
          {plugins.map((p) => (
            <li
              key={p.name}
              className="flex items-center gap-2 text-[12px] px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-800/50"
            >
              {p.ok ? (
                <CheckCircle size={12} className="text-emerald-500 shrink-0" />
              ) : (
                <XCircle size={12} className="text-red-500 shrink-0" />
              )}
              <code className="font-mono text-[11px]">{p.name}</code>
              {!p.ok && p.error && (
                <span className="text-[11px] text-red-500 truncate">{p.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
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

function AttachmentPolicyField() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['vault-settings'], queryFn: api.getVaultSettings });
  const policy = settingsQ.data?.settings.attachmentPolicy ?? 'global';
  const mut = useMutation({
    mutationFn: (next: 'global' | 'per-box') =>
      api.patchVaultSettings({ attachmentPolicy: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault-settings'] }),
  });
  return (
    <Field
      label="Attachment location"
      hint="Where pasted/uploaded files land. per-box puts them under attachments/<focused-box-id>/"
    >
      <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full p-1">
        {(['global', 'per-box'] as const).map((value) => (
          <button
            key={value}
            onClick={() => mut.mutate(value)}
            disabled={mut.isPending}
            className={`px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${
              policy === value
                ? 'bg-white dark:bg-gray-700 text-ink dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-200'
            }`}
          >
            {value === 'global' ? 'Global' : 'Per-box'}
          </button>
        ))}
      </div>
    </Field>
  );
}
