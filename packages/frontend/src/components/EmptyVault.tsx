import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, FileText, FolderTree, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { dialog } from '../lib/dialog';
import { usePaneStore } from '../store/paneStore';

/**
 * 空仓库的引导屏：第一次打开时给一个明确的"下一步"，而不是冷冰冰的提示。
 * 三个选项：
 *   - 一键种子：建一棵示例树，让人看到 INDEX/Folgezettel 长啥样
 *   - 创建第一张卡：弹 dialog 起 1
 *   - 今天的 daily：直接进入写作流
 */
export function EmptyVault() {
  const qc = useQueryClient();
  const openTab = usePaneStore((s) => s.openTab);
  const navigateTo = (boxId: string, focusId: string, title: string) =>
    openTab({ kind: 'card', title, cardBoxId: boxId, cardFocusId: focusId });
  const [creating, setCreating] = useState(false);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['cards'] });
    qc.invalidateQueries({ queryKey: ['indexes'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
  };

  const seed = async () => {
    setCreating(true);
    try {
      // 建一组示范卡片，让用户看到 Folgezettel 长啥样
      // status 不再传 —— 它从结构派生（1 因为有 1a/1b 子卡，自动是 INDEX）
      const seeds: Array<{
        luhmannId: string;
        title: string;
        content: string;
        tags: string[];
      }> = [
        {
          luhmannId: '1',
          title: 'Welcome to Folium',
          tags: ['welcome'],
          content:
            "# Welcome\n\nThis card has children (1a, 1b), so it acts as an INDEX. Status is derived from structure — no need to mark it.\n\nTry these:\n\n- Press ⌘K to quickly jump anywhere\n- Press ⌘B to toggle the sidebar\n- Click the Settings cog to tweak theme & hotkeys\n",
        },
        {
          luhmannId: '1a',
          title: 'How Folgezettel IDs work',
          tags: ['welcome'],
          content:
            "Cards are identified by **Folgezettel** ids: alternating digits and letters.\n\n- `1`, `2`, `3` are top-level cards\n- `1a`, `1b` are children of `1`\n- `1a1`, `1a2` are children of `1a`\n\nEach card has its own .md file. The system parses ids from filenames.\n",
        },
        {
          luhmannId: '1b',
          title: 'Linking ideas',
          tags: ['welcome'],
          content:
            "Two ways to link:\n\n1. **Manual** — `[[1a]]` or `[[some-other-id]]` in the body\n2. **Tags** — group cards across the tree, e.g. `#welcome`\n\nBacklinks show automatically on the focused card. Try editing me and adding `[[1]]`.\n",
        },
      ];
      for (const s of seeds) {
        await api.createCard(s);
      }
      refreshAll();
      // 1 是 INDEX，把它当 box，1a 当 focus
      navigateTo('1', '1a', 'How Folgezettel IDs work');
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Seed failed' });
    } finally {
      setCreating(false);
    }
  };

  const createFirst = async () => {
    const id = await dialog.prompt('Pick an id for your first card (e.g. "1")', {
      title: 'Create card',
      defaultValue: '1',
      confirmLabel: 'Create',
    });
    if (!id?.trim()) return;
    const title = await dialog.prompt('Title?', {
      title: 'Create card',
      defaultValue: 'My first note',
      confirmLabel: 'Create',
    });
    if (!title?.trim()) return;
    setCreating(true);
    try {
      await api.createCard({
        luhmannId: id.trim(),
        title: title.trim(),
        content: '',
        tags: [],
      });
      refreshAll();
      navigateTo(id.trim(), id.trim(), title.trim());
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Create failed' });
    } finally {
      setCreating(false);
    }
  };

  const startDaily = async () => {
    setCreating(true);
    try {
      const { luhmannId } = await api.openOrCreateDaily();
      refreshAll();
      navigateTo(luhmannId, luhmannId, `Daily ${luhmannId}`);
    } catch (err) {
      dialog.alert((err as Error).message, { title: 'Daily failed' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="max-w-xl w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center">
            <FolderTree className="text-accent" size={32} />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">Your vault is empty</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Pick one to get started. You can always restructure later — the system follows your lead.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-left">
          <button
            disabled={creating}
            onClick={seed}
            className="group p-4 rounded-xl border-2 border-accent bg-accent/5 hover:bg-accent/10 transition-colors disabled:opacity-50"
          >
            <Sparkles size={18} className="text-accent mb-2" />
            <div className="text-[13px] font-bold mb-1">Try with examples</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Creates 3 demo cards (1, 1a, 1b) so you can see how Folgezettel works
            </div>
          </button>
          <button
            disabled={creating}
            onClick={createFirst}
            className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors disabled:opacity-50"
          >
            <FileText size={18} className="text-gray-600 dark:text-gray-400 mb-2" />
            <div className="text-[13px] font-bold mb-1">Create one card</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Pick your own id and title — start blank
            </div>
          </button>
          <button
            disabled={creating}
            onClick={startDaily}
            className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors disabled:opacity-50"
          >
            <CalendarDays size={18} className="text-gray-600 dark:text-gray-400 mb-2" />
            <div className="text-[13px] font-bold mb-1">Start a daily note</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Skip the structure for today — just write
            </div>
          </button>
        </div>
        <p className="text-[10px] text-gray-400">
          Or drop existing .md files into the vault directory and they'll show up automatically.
        </p>
      </div>
    </div>
  );
}
