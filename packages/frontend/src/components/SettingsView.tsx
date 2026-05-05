import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clipboard, KeyRound, Moon, Sun, Monitor, RefreshCw, CheckCircle, XCircle, Trash2, ExternalLink, Download } from 'lucide-react';
import { useUIStore, type Language, type Theme } from '../store/uiStore';
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
import { API_BASE } from '../lib/backendUrl';
import { getDesktopApiToken, isDesktopApp } from '../lib/desktop';
import { t } from '../lib/i18n';

export function SettingsView() {
  // 在 modal 模式下，"返回"只需要关弹窗；其他场景由模态外层处理
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  const panels = PluginRegistry.settingsPanels.list().sort((a, b) => a.order - b.order);

  return (
    <div className="max-w-3xl mx-auto py-10 px-8 space-y-8 text-ink dark:text-gray-200">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('settings.title', {}, language)}</h1>
        <button
          onClick={() => setSettingsOpen(false)}
          className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-ink dark:hover:text-gray-100"
        >
          {t('common.close', {}, language)}
        </button>
      </header>

      <Section title={t('settings.appearance', {}, language)}>
        <Field label={t('settings.theme', {}, language)} hint={t('settings.themeHint', {}, language)}>
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full p-1">
            {([
              ['light', <Sun key="s" size={12} />, t('settings.light', {}, language)],
              ['dark', <Moon key="m" size={12} />, t('settings.dark', {}, language)],
              ['auto', <Monitor key="a" size={12} />, t('settings.auto', {}, language)],
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
        <Field label={t('settings.language', {}, language)} hint={t('settings.languageHint', {}, language)}>
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full p-1">
            {([
              ['auto', <Monitor key="la" size={12} />, t('settings.auto', {}, language)],
              ['en', <span key="en" className="text-[11px] font-black">EN</span>, t('settings.english', {}, language)],
              ['zh', <span key="zh" className="text-[11px] font-black">中</span>, t('settings.chinese', {}, language)],
            ] as Array<[Language, JSX.Element, string]>).map(([value, icon, label]) => (
              <button
                key={value}
                onClick={() => setLanguage(value)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${
                  language === value
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

      <Section title={t('settings.aiApi', {}, language)}>
        <LocalApiPanel language={language} />
      </Section>

      <Section title={t('settings.general', {}, language)}>
        <Field label={t('settings.vaultStructure', {}, language)} hint={t('settings.vaultStructureHint', {}, language)}>
          <code className="text-[12px] bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded">{`(env: VAULT_PATH)`}</code>
        </Field>
      </Section>

      <Section title={t('settings.attachments', {}, language)}>
        <AttachmentPolicyField />
        <AttachmentManager />
      </Section>

      <Section title={t('settings.backupRecovery', {}, language)}>
        <BackupAndRecoveryPanel />
      </Section>

      <Section title={t('settings.maintenance', {}, language)}>
        <MaintenancePanel />
      </Section>

      <Section title={t('settings.hotkeys', {}, language)}>
        <HotkeysPanel />
      </Section>

      <Section title={t('settings.discoveries', {}, language)}>
        <DiscoveriesPanel />
      </Section>

      <Section title={t('settings.searchReplace', {}, language)}>
        <SearchReplacePanel />
      </Section>

      <Section title={t('settings.export', {}, language)}>
        <ExportPanel />
      </Section>

      <Section title={t('settings.trash', {}, language)}>
        <TrashPanel />
      </Section>

      <Section title={t('settings.plugins', {}, language)}>
        <PluginsPanel />
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          {t('settings.pluginStats', {
            commands: PluginRegistry.commands.list().length,
            sidebarItems: PluginRegistry.sidebarItems.list().length,
            panels: panels.length,
          }, language)}
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
  const language = useUIStore((s) => s.language);
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
        label={t('settings.font.ui', {}, language)}
        value={fonts.ui}
        disabled={mut.isPending}
        onChange={(value) => patchFont('ui', value)}
      />
      <FontSelect
        label={t('settings.font.body', {}, language)}
        value={fonts.body}
        disabled={mut.isPending}
        onChange={(value) => patchFont('body', value)}
      />
      <FontSelect
        label={t('settings.font.headings', {}, language)}
        value={fonts.display}
        disabled={mut.isPending}
        onChange={(value) => patchFont('display', value)}
      />
      <FontSelect
        label={t('settings.font.code', {}, language)}
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

function LocalApiPanel({ language }: { language: Language }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1200);
  };
  const copyToken = async () => {
    const token = await getDesktopApiToken();
    if (!token) {
      await dialog.alert(t('api.devUnprotected', {}, language), { title: t('settings.aiApi', {}, language) });
      return;
    }
    await copy('token', token);
  };
  const authHeader = 'X-Folium-Token: <token>';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-2 text-[12px]">
        <div className="font-bold text-gray-500 dark:text-gray-400">{t('api.endpoint', {}, language)}</div>
        <div className="flex items-center gap-2 min-w-0">
          <code className="min-w-0 truncate bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded">{API_BASE}</code>
          <button
            onClick={() => void copy('endpoint', API_BASE)}
            className="shrink-0 inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-700 px-2 py-1 text-[11px] font-bold hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Clipboard size={11} />
            {copied === 'endpoint' ? t('api.copied', {}, language) : t('api.copyEndpoint', {}, language)}
          </button>
        </div>
        <div className="font-bold text-gray-500 dark:text-gray-400">{t('api.auth', {}, language)}</div>
        <div className="flex items-center gap-2 min-w-0">
          <code className="min-w-0 truncate bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded">
            {isDesktopApp() ? authHeader : t('api.devUnprotected', {}, language)}
          </code>
          {isDesktopApp() && (
            <button
              onClick={() => void copyToken()}
              className="shrink-0 inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-700 px-2 py-1 text-[11px] font-bold hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <KeyRound size={11} />
              {copied === 'token' ? t('api.copied', {}, language) : t('api.copyToken', {}, language)}
            </button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        {isDesktopApp() ? t('api.desktopProtected', {}, language) : t('api.devUnprotected', {}, language)}
      </p>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {t('api.docsHint', {}, language)}
      </p>
    </div>
  );
}

function MaintenancePanel() {
  const qc = useQueryClient();
  const language = useUIStore((s) => s.language);
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
        <div className="text-sm font-semibold">{t('maintenance.repairTitle', {}, language)}</div>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
          {t('maintenance.repairHint', {}, language)}
        </p>
      </div>
      <button
        onClick={() => repairMut.mutate()}
        disabled={repairMut.isPending}
        className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-bold px-3 py-2 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
      >
        <RefreshCw size={13} className={repairMut.isPending ? 'animate-spin' : ''} />
        {t('maintenance.repair', {}, language)}
      </button>
    </div>
  );
}

function PluginsPanel() {
  const language = useUIStore((s) => s.language);
  const [plugins, setPlugins] = useState<LoadedPlugin[]>(() => listLoadedPlugins());
  const [reloading, setReloading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const official = useQuery({
    queryKey: ['official-plugins'],
    queryFn: api.listOfficialPlugins,
  });
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
  const installOfficial = async (name: string) => {
    setInstalling(name);
    try {
      await api.installOfficialPlugin(name);
      await official.refetch();
      setPlugins(await reloadPlugins());
    } catch (err) {
      await dialog.alert((err as Error).message, { title: t('plugins.installFailed', {}, language) });
    } finally {
      setInstalling(null);
    }
  };
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-800/35 p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-bold">{t('plugins.official', {}, language)}</div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {t('plugins.officialHint', {}, language)}
            </p>
          </div>
          <button
            onClick={() => void official.refetch()}
            className="text-[10px] font-bold px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-white dark:hover:bg-gray-800"
          >
            {t('common.refresh', {}, language)}
          </button>
        </div>
        <div className="grid gap-2">
          {(official.data?.plugins ?? []).map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-3 rounded-md bg-white dark:bg-[#1e2030] border border-gray-200/70 dark:border-gray-700 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-[12px] font-bold truncate">{p.title}</div>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{p.description}</p>
              </div>
              <div className="flex-1" />
              {p.installed && <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{t('plugins.installed', {}, language)}</span>}
              <button
                onClick={() => void installOfficial(p.name)}
                disabled={installing === p.name || reloading}
                className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                <Download size={11} />
                {p.installed ? t('common.update', {}, language) : t('common.install', {}, language)}
              </button>
            </div>
          ))}
          {!official.isLoading && (official.data?.plugins.length ?? 0) === 0 && (
            <p className="text-[11px] text-gray-400">{t('plugins.noneOfficial', {}, language)}</p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {t('plugins.dropHint', {}, language)}
        </p>
        <button
          onClick={onReload}
          disabled={reloading}
          className="text-[11px] font-bold flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
        >
          <RefreshCw size={11} className={reloading ? 'animate-spin' : ''} />
          {t('plugins.reload', {}, language)}
        </button>
      </div>
      {plugins.length === 0 ? (
        <p className="text-[11px] text-gray-400">{t('plugins.noneLoaded', {}, language)}</p>
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
                {isPluginEnabled(p.name) ? t('common.disable', {}, language) : t('common.enable', {}, language)}
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
  const language = useUIStore((s) => s.language);
  const settingsQ = useQuery({ queryKey: ['vault-settings'], queryFn: api.getVaultSettings });
  const policy = settingsQ.data?.settings.attachmentPolicy ?? 'global';
  const mut = useMutation({
    mutationFn: (next: 'global' | 'per-box') =>
      api.patchVaultSettings({ attachmentPolicy: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault-settings'] }),
  });
  return (
    <Field
      label={t('attachments.location', {}, language)}
      hint={t('attachments.locationHint', {}, language)}
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
            {value === 'global' ? t('attachments.global', {}, language) : t('attachments.perBox', {}, language)}
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
  const language = useUIStore((s) => s.language);
  const attachmentsQ = useQuery({ queryKey: ['attachments'], queryFn: api.listAttachments });
  const deleteMut = useMutation({
    mutationFn: ({ path, force }: { path: string; force?: boolean }) => api.deleteAttachment(path, { force }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments'] }),
    onError: (err: Error) => dialog.alert(err.message, { title: t('attachments.deleteFailed', {}, language) }),
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
          <div className="text-[12px] font-semibold">{t('attachments.files', {}, language)}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('attachments.filesHint', {}, language)}
          </div>
        </div>
        <button
          onClick={() => attachmentsQ.refetch()}
          className="text-[11px] font-bold px-2.5 py-1 rounded border border-gray-200 dark:border-[#363a4f] hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {t('common.refresh', {}, language)}
        </button>
      </div>

      <div className="border border-gray-200 dark:border-[#363a4f] rounded-lg overflow-hidden">
        {attachmentsQ.isLoading && <div className="px-3 py-3 text-[12px] text-gray-400">{t('attachments.loading', {}, language)}</div>}
        {!attachmentsQ.isLoading && attachments.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-gray-400">{t('attachments.none', {}, language)}</div>
        )}
        {attachments.map((file) => (
          <div
            key={file.relativePath}
            className="flex items-center gap-3 px-3 py-2 border-t first:border-t-0 border-gray-100 dark:border-[#363a4f]"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] truncate">{file.relativePath}</div>
              <div className="text-[10px] text-gray-400">
                {formatBytes(file.size)} · {file.referencedBy.length === 0
                  ? t('attachments.unused', {}, language)
                  : t('attachments.usedBy', { ids: file.referencedBy.map((r) => r.luhmannId).join(', ') }, language)}
              </div>
            </div>
            <button
              onClick={() => api.openAttachment(file.relativePath).catch((err) => dialog.alert((err as Error).message, { title: t('attachments.openFailed', {}, language) }))}
              className="p-1 text-gray-400 hover:text-accent"
              title={t('attachments.open', {}, language)}
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
              title={file.referencedBy.length > 0 ? t('attachments.deleteReferenced', {}, language) : t('attachments.deleteUnused', {}, language)}
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
