import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, Monitor, RefreshCw, CheckCircle, XCircle, Trash2, ExternalLink } from 'lucide-react';
import { useUIStore, type Theme } from '../store/uiStore';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';
import { PluginRegistry } from '../lib/pluginRegistry';
import {
  isPluginEnabled,
  listLoadedPlugins,
  reloadPlugins,
  setPluginEnabled,
  type LoadedPlugin,
} from '../lib/pluginLoader';
import { HotkeysPanel } from './HotkeysPanel';
import { TrashPanel } from './TrashPanel';
import { SearchReplacePanel } from './SearchReplacePanel';
import { ExportPanel } from './ExportPanel';
import { DiscoveriesPanel } from './DiscoveriesPanel';
import type { FontSettings } from '../lib/api';

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
        <FontSettingsPanel />
      </Section>

      <Section title="General">
        <Field label="Vault structure" hint="The selected folder is the vault root. Cards live as Markdown files in it; attachments live in attachments/; app data lives in .zettel/.">
          <code className="text-[12px] bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded">{`(env: VAULT_PATH)`}</code>
        </Field>
      </Section>

      <Section title="Attachments">
        <AttachmentPolicyField />
        <AttachmentManager />
      </Section>

      <Section title="Backup & Recovery">
        <BackupAndRecoveryPanel />
      </Section>

      <Section title="Maintenance">
        <MaintenancePanel />
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

const FONT_PRESETS = [
  { label: 'Inter', value: 'Inter' },
  { label: 'Newsreader', value: 'Newsreader' },
  { label: 'System UI', value: 'system-ui' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Serif', value: 'serif' },
  { label: 'Sans Serif', value: 'sans-serif' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Monospace', value: 'monospace' },
] as const;

const DEFAULT_FONTS: FontSettings = {
  ui: 'Inter',
  body: 'Inter',
  display: 'Newsreader',
  mono: 'JetBrains Mono',
};

function FontSettingsPanel() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['vault-settings'], queryFn: api.getVaultSettings });
  const fonts = settingsQ.data?.settings.fonts ?? DEFAULT_FONTS;
  const mut = useMutation({
    mutationFn: (next: FontSettings) => api.patchVaultSettings({ fonts: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault-settings'] }),
  });
  const patchFont = (key: keyof FontSettings, value: string) => {
    mut.mutate({ ...fonts, [key]: value });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
      <FontSelect
        label="UI"
        value={fonts.ui}
        disabled={mut.isPending}
        onChange={(value) => patchFont('ui', value)}
      />
      <FontSelect
        label="Card body"
        value={fonts.body}
        disabled={mut.isPending}
        onChange={(value) => patchFont('body', value)}
      />
      <FontSelect
        label="Headings"
        value={fonts.display}
        disabled={mut.isPending}
        onChange={(value) => patchFont('display', value)}
      />
      <FontSelect
        label="Code / IDs"
        value={fonts.mono}
        disabled={mut.isPending}
        onChange={(value) => patchFont('mono', value)}
      />
    </div>
  );
}

function FontSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded border border-gray-200 dark:border-[#363a4f] px-3 py-2">
      <span className="text-[12px] font-semibold text-gray-600 dark:text-gray-300">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-40 rounded border border-gray-200 dark:border-[#494d64] bg-white dark:bg-[#24273a] px-2 py-1 text-[12px] outline-none focus:border-accent"
      >
        {FONT_PRESETS.map((font) => (
          <option key={font.value} value={font.value}>
            {font.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MaintenancePanel() {
  const qc = useQueryClient();
  const repairMut = useMutation({
    mutationFn: api.repairWorkspaces,
    onSuccess: async (report) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['workspace'] });
      qc.invalidateQueries({ queryKey: ['ws-links-batch'] });
      await dialog.alert(
        `Scanned ${report.workspacesScanned} workspace(s).\nRemoved ${report.nodesRemoved} duplicate node(s).\nRemoved ${report.edgesRemoved} invalid/duplicate edge(s).\nNormalized ${report.edgesNormalized} workspace(s).`,
        { title: 'Workspace repair complete' },
      );
    },
    onError: (err: Error) => dialog.alert(err.message, { title: 'Workspace repair failed' }),
  });

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-semibold">Repair workspace data</div>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
          Normalizes old edge states, removes dangling edges, and merges duplicate card nodes.
        </p>
      </div>
      <button
        onClick={() => repairMut.mutate()}
        disabled={repairMut.isPending}
        className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-bold px-3 py-2 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
      >
        <RefreshCw size={13} className={repairMut.isPending ? 'animate-spin' : ''} />
        Repair
      </button>
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
  const togglePlugin = async (name: string, enabled: boolean) => {
    setPluginEnabled(name, enabled);
    setReloading(true);
    try {
      setPlugins(await reloadPlugins());
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
              {p.disabled ? (
                <XCircle size={12} className="text-gray-400 shrink-0" />
              ) : p.ok ? (
                <CheckCircle size={12} className="text-emerald-500 shrink-0" />
              ) : (
                <XCircle size={12} className="text-red-500 shrink-0" />
              )}
              <code className="font-mono text-[11px]">{p.manifest?.name ?? p.name}</code>
              {p.manifest?.version && (
                <span className="text-[10px] text-gray-400">v{p.manifest.version}</span>
              )}
              {!p.ok && p.error && (
                <span className={`text-[11px] truncate ${p.error === 'disabled' ? 'text-gray-400' : 'text-red-500'}`}>
                  {p.error}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => void togglePlugin(p.name, !isPluginEnabled(p.name))}
                disabled={reloading}
                className="text-[10px] font-bold px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                {isPluginEnabled(p.name) ? 'Disable' : 'Enable'}
              </button>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentManager() {
  const qc = useQueryClient();
  const attachmentsQ = useQuery({ queryKey: ['attachments'], queryFn: api.listAttachments });
  const deleteMut = useMutation({
    mutationFn: ({ path, force }: { path: string; force?: boolean }) => api.deleteAttachment(path, { force }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments'] }),
    onError: (err: Error) => dialog.alert(err.message, { title: 'Delete attachment failed' }),
  });
  const attachments = attachmentsQ.data?.attachments ?? [];

  const deleteAttachment = async (path: string, refCount: number) => {
    const ok = await dialog.confirm(`Delete attachment?\n\n${path}`, {
      title: refCount > 0 ? 'Delete referenced attachment' : 'Delete attachment',
      description:
        refCount > 0
          ? `This file is referenced by ${refCount} card${refCount === 1 ? '' : 's'}. The Markdown link will remain but point to a missing file.`
          : 'This removes the file from the vault attachments folder.',
      confirmLabel: 'Delete file',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMut.mutate({ path, force: refCount > 0 });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold">Attachment files</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            PDFs and other files stay in the vault's attachments folder. Referenced files can be opened here.
          </div>
        </div>
        <button
          onClick={() => attachmentsQ.refetch()}
          className="text-[11px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-[#363a4f] hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Refresh
        </button>
      </div>

      <div className="border border-gray-200 dark:border-[#363a4f] rounded-lg overflow-hidden">
        {attachmentsQ.isLoading && <div className="px-3 py-3 text-[12px] text-gray-400">Loading attachments...</div>}
        {!attachmentsQ.isLoading && attachments.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-gray-400">No attachments found.</div>
        )}
        {attachments.map((file) => (
          <div
            key={file.relativePath}
            className="flex items-center gap-3 px-3 py-2 border-t first:border-t-0 border-gray-100 dark:border-[#363a4f]"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] truncate">{file.relativePath}</div>
              <div className="text-[10px] text-gray-400">
                {formatBytes(file.size)} · {file.referencedBy.length === 0 ? 'unused' : `used by ${file.referencedBy.map((r) => r.luhmannId).join(', ')}`}
              </div>
            </div>
            <button
              onClick={() => api.openAttachment(file.relativePath).catch((err) => dialog.alert((err as Error).message, { title: 'Open attachment failed' }))}
              className="p-1 text-gray-400 hover:text-accent"
              title="Open attachment"
            >
              <ExternalLink size={14} />
            </button>
            <button
              onClick={() => void deleteAttachment(file.relativePath, file.referencedBy.length)}
              disabled={deleteMut.isPending}
              className={`p-1 ${
                file.referencedBy.length > 0
                  ? 'text-gray-300 hover:text-red-500'
                  : 'text-gray-400 hover:text-red-500'
              } disabled:opacity-40`}
              title={file.referencedBy.length > 0 ? 'Delete referenced file' : 'Delete unused file'}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Backup & Recovery 面板：
 *  - 自动备份开关 + 间隔/保留份数配置
 *  - 立即备份按钮
 *  - 备份列表（restore / purge）
 *  - 重建索引按钮（修复元数据漂移）
 */
function BackupAndRecoveryPanel() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['vault-settings'], queryFn: api.getVaultSettings });
  const backupsQ = useQuery({ queryKey: ['backups'], queryFn: api.listBackups });
  const settings = settingsQ.data?.settings;

  const patchMut = useMutation({
    mutationFn: (
      patch: Partial<{ backupEnabled: boolean; backupIntervalHours: number; backupKeep: number }>,
    ) => api.patchVaultSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault-settings'] }),
  });
  const createMut = useMutation({
    mutationFn: () => api.createBackupNow(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
    onError: (err: Error) => alert('Backup failed: ' + err.message),
  });
  const restoreMut = useMutation({
    mutationFn: (fileName: string) => api.restoreBackup(fileName),
    onSuccess: () => {
      // 还原后所有 cache 都不可信，全清
      qc.clear();
      qc.invalidateQueries();
    },
    onError: (err: Error) => alert('Restore failed: ' + err.message),
  });
  const purgeMut = useMutation({
    mutationFn: (fileName: string) => api.purgeBackup(fileName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
  const rebuildMut = useMutation({
    mutationFn: () => api.rebuildIndex(),
    onSuccess: (r) => {
      qc.invalidateQueries();
      alert(`Index rebuilt — ${r.cards} cards in ${r.durationMs}ms`);
    },
    onError: (err: Error) => alert('Rebuild failed: ' + err.message),
  });

  const entries = backupsQ.data?.entries ?? [];

  return (
    <div className="space-y-4">
      <Field
        label="Auto-backup"
        hint="Default ON. Snapshots vault to .zettel/backups/<timestamp>.zip on a schedule."
      >
        <button
          onClick={() => settings && patchMut.mutate({ backupEnabled: !settings.backupEnabled })}
          disabled={patchMut.isPending || !settings}
          className={`px-3 py-1 rounded-full text-[11px] font-bold ${
            settings?.backupEnabled
              ? 'bg-emerald-500 text-white'
              : 'bg-gray-200 text-gray-500'
          }`}
        >
          {settings?.backupEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </Field>

      {settings?.backupEnabled && (
        <>
          <Field label="Interval (hours)" hint="How often to auto-snapshot. Default 24h.">
            <input
              type="number"
              min={1}
              max={168}
              value={settings.backupIntervalHours}
              onChange={(e) => patchMut.mutate({ backupIntervalHours: Number(e.target.value) })}
              className="w-20 text-[12px] px-2 py-1 border border-gray-200 dark:border-gray-700 rounded text-center"
            />
          </Field>
          <Field label="Keep last N backups" hint="Older snapshots are auto-pruned.">
            <input
              type="number"
              min={1}
              max={100}
              value={settings.backupKeep}
              onChange={(e) => patchMut.mutate({ backupKeep: Number(e.target.value) })}
              className="w-20 text-[12px] px-2 py-1 border border-gray-200 dark:border-gray-700 rounded text-center"
            />
          </Field>
        </>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500">
          {entries.length} backup{entries.length === 1 ? '' : 's'} in <code className="text-[11px]">.zettel/backups/</code>
        </p>
        <button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="text-[11px] font-bold px-3 py-1 rounded-full bg-accent text-white hover:bg-accent/90"
        >
          {createMut.isPending ? 'Backing up…' : 'Backup now'}
        </button>
      </div>

      {entries.length > 0 && (
        <div className="border border-gray-200 dark:border-[#363a4f] rounded divide-y divide-gray-100 dark:divide-[#363a4f]">
          {entries.map((e) => (
            <div key={e.fileName} className="flex items-center gap-3 px-3 py-2 group hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-mono truncate">{e.fileName}</div>
                <div className="text-[10px] text-gray-400">
                  {(e.size / 1024).toFixed(1)} KB · {new Date(e.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`Restore vault from ${e.fileName}?\n\nCurrent vault state will be auto-backed-up first as "pre-restore-".`)) return;
                  restoreMut.mutate(e.fileName);
                }}
                className="opacity-0 group-hover:opacity-100 text-[11px] font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded hover:bg-emerald-50"
              >
                Restore
              </button>
              <button
                onClick={() => {
                  if (!confirm(`Permanently delete backup ${e.fileName}?`)) return;
                  purgeMut.mutate(e.fileName);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500"
                title="Permanently delete"
              >
                <XCircle size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="pt-3 border-t border-gray-100 dark:border-gray-700">
        <Field
          label="Rebuild index"
          hint="Wipe SQLite + re-scan all .md files. Use if metadata feels stale or files were edited externally."
        >
          <button
            onClick={() => {
              if (!confirm('Truncate index and re-scan vault? This is non-destructive (only SQLite is wiped, .md files untouched).')) return;
              rebuildMut.mutate();
            }}
            disabled={rebuildMut.isPending}
            className="text-[11px] font-bold px-3 py-1 rounded-full border border-orange-300 text-orange-600 hover:bg-orange-50"
          >
            {rebuildMut.isPending ? 'Rebuilding…' : 'Rebuild now'}
          </button>
        </Field>
      </div>
    </div>
  );
}
