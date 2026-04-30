import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { isDesktopApp, selectVaultDirectory } from '../lib/desktop';
import { dialog } from '../lib/dialog';
import { usePaneStore } from '../store/paneStore';

const DISMISS_KEY = 'zk-first-run-vault-dismissed';

function isBundledExampleVault(path: string | undefined): boolean {
  if (!path) return false;
  return /(?:^|[/\\])example-vault[/\\]?$/.test(path);
}

export function shouldShowFirstRunVaultOnboarding(input: {
  isDesktop: boolean;
  activePath?: string;
  vaultCount: number;
  dismissed: boolean;
}): boolean {
  return input.isDesktop && (input.vaultCount === 0 || (!input.dismissed && isBundledExampleVault(input.activePath)));
}

export function FirstRunVaultOnboarding() {
  const qc = useQueryClient();
  const vaultsQ = useQuery({ queryKey: ['vaults'], queryFn: api.listVaults });
  const active = vaultsQ.data?.active;
  const vaultCount = vaultsQ.data?.vaults.length ?? 0;
  const dismissed = window.localStorage.getItem(DISMISS_KEY) === '1';
  const visible = shouldShowFirstRunVaultOnboarding({
    isDesktop: isDesktopApp(),
    activePath: active?.path,
    vaultCount,
    dismissed,
  });

  const refreshAfterVaultChange = async () => {
    qc.clear();
    usePaneStore.getState().reset();
    await qc.refetchQueries({ queryKey: ['vaults'] });
  };

  const openVaultMut = useMutation({
    mutationFn: async (path: string) => {
      const { vault } = await api.registerVault(path);
      await api.switchVault(vault.id);
      return vault;
    },
    onSuccess: async () => {
      window.localStorage.setItem(DISMISS_KEY, '1');
      await refreshAfterVaultChange();
    },
    onError: (err: Error) => dialog.alert(err.message, { title: 'Open vault failed' }),
  });

  if (!visible) return null;

  const chooseDirectory = async (createDirectory: boolean) => {
    const path = await selectVaultDirectory({
      title: createDirectory ? 'Create or choose a vault folder' : 'Open existing vault folder',
      buttonLabel: createDirectory ? 'Use as Vault' : 'Open Vault',
      createDirectory,
    });
    if (!path) return;
    await openVaultMut.mutateAsync(path);
  };

  return (
    <div className="absolute inset-0 z-[2000] bg-surface dark:bg-[#24273a] flex items-center justify-center p-8">
      <div className="max-w-3xl w-full">
        <div className="mb-8">
          <div className="text-[10px] font-black uppercase tracking-[0.22em] text-accent mb-3">
            First Run
          </div>
          <h1 className="font-display text-4xl leading-tight text-ink dark:text-[#cad3f5]">
            Choose where your notes live
          </h1>
          <p className="mt-3 text-sm leading-7 text-gray-500 dark:text-[#a5adcb] max-w-2xl">
            Folium stores your vault as local Markdown files. Pick an empty folder for a new vault,
            or open an existing folder that already contains cards.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            disabled={openVaultMut.isPending}
            onClick={() => void chooseDirectory(true)}
            className="text-left p-5 rounded-lg border-2 border-accent bg-accent/5 hover:bg-accent/10 transition-colors disabled:opacity-50"
          >
            <Plus size={20} className="text-accent mb-4" />
            <div className="text-sm font-bold text-ink dark:text-[#cad3f5]">Create new vault</div>
            <div className="mt-2 text-xs leading-6 text-gray-500 dark:text-[#a5adcb]">
              Choose or create an empty folder, then start with a blank vault.
            </div>
          </button>

          <button
            disabled={openVaultMut.isPending}
            onClick={() => void chooseDirectory(false)}
            className="text-left p-5 rounded-lg border border-paperEdge bg-paper/70 hover:border-accent/40 hover:bg-accentSoft/50 transition-colors disabled:opacity-50"
          >
            <FolderOpen size={20} className="text-accent mb-4" />
            <div className="text-sm font-bold text-ink dark:text-[#cad3f5]">Open existing folder</div>
            <div className="mt-2 text-xs leading-6 text-gray-500 dark:text-[#a5adcb]">
              Use a folder with existing Markdown cards or an older vault.
            </div>
          </button>

        </div>

        {active?.path && (
          <div className="mt-5 text-[11px] text-gray-400 font-mono truncate">
            Current: {active.path}
          </div>
        )}
      </div>
    </div>
  );
}
