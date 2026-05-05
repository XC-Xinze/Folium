import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Loader2, Paperclip } from 'lucide-react';
import { api } from '../lib/api';
import { applyTextareaEdit, continueMarkdownList, indentMarkdownLines } from '../lib/markdownInput';
import { dialog } from '../lib/dialog';
import { t } from '../lib/i18n';
import { useUIStore } from '../store/uiStore';

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

export function CardPageView({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const language = useUIStore((s) => s.language);
  const cardQ = useQuery({ queryKey: ['card', cardId], queryFn: () => api.getCard(cardId) });
  const card = cardQ.data;
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const hydratedCardId = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!card) return;
    if (hydratedCardId.current === card.luhmannId) return;
    hydratedCardId.current = card.luhmannId;
    setDraftTitle(card.title);
    setDraftContent(card.contentMd);
    setDraftTags(card.tags.join(', '));
    setSaveState('clean');
  }, [card]);

  const markDirty = () => {
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
  };

  const save = async (silent = false) => {
    if (!card) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const tags = draftTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      setSaveState('saving');
      const updated = await api.updateCard(card.luhmannId, {
        title: draftTitle.trim() || card.luhmannId,
        content: draftContent,
        tags,
      });
      qc.setQueryData(['card', card.luhmannId], updated);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['indexes'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['linked'] });
      qc.invalidateQueries({ queryKey: ['backlinks'] });
      setSaveState('saved');
      window.setTimeout(() => setSaveState('clean'), 900);
    } catch (err) {
      setSaveState('error');
      if (!silent) dialog.alert((err as Error).message, { title: t('common.saveFailed', {}, language) });
    }
  };

  const insertAtCursor = (text: string, replaceFromTo?: { from: number; to: number }) => {
    const ta = textareaRef.current;
    if (!ta) {
      setDraftContent((value) => value + text);
      markDirty();
      return;
    }
    const start = replaceFromTo?.from ?? ta.selectionStart;
    const end = replaceFromTo?.to ?? ta.selectionEnd;
    const next = ta.value.slice(0, start) + text + ta.value.slice(end);
    setDraftContent(next);
    markDirty();
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const attachmentBoxId = card?.luhmannId.match(/^\d+/)?.[0] ?? card?.parentId ?? null;

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0 || !card) return;
    const list = Array.from(files);
    const ta = textareaRef.current;
    const baseStart = ta?.selectionStart ?? draftContent.length;
    const token = `folium-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const placeholder = list.map((file, index) => `![uploading ${file.name}](upload://${token}-${index})`).join('\n') + '\n';
    insertAtCursor(placeholder);
    let replacement = '';
    for (const file of list) {
      try {
        const uploaded = await api.uploadAttachment(file, attachmentBoxId);
        const alt = uploaded.filename.replace(/\.[^.]+$/, '');
        replacement += uploaded.mimetype.startsWith('image/')
          ? `![${alt}](${uploaded.relativePath})\n`
          : `[${uploaded.filename}](${uploaded.relativePath})\n`;
      } catch (err) {
        replacement += `<!-- upload failed: ${(err as Error).message} -->\n`;
      }
    }
    setDraftContent((current) => {
      const next = current.includes(placeholder)
        ? current.replace(placeholder, replacement)
        : current.slice(0, baseStart) + replacement + current.slice(baseStart + placeholder.length);
      return next;
    });
    markDirty();
    requestAnimationFrame(() => {
      const pos = baseStart + replacement.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    if (!card || saveState !== 'dirty') return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void save(true);
    }, 900);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [card, draftTitle, draftContent, draftTags, saveState]);

  if (cardQ.isLoading) {
    return <div className="h-full grid place-items-center text-sm text-muted">{t('common.loadingCard', {}, language)}</div>;
  }
  if (!card) {
    return <div className="h-full grid place-items-center text-sm text-muted">{t('common.cardNotFound', {}, language)}</div>;
  }

  const status = (() => {
    if (saveState === 'saving') return { icon: <Loader2 size={12} className="animate-spin" />, text: t('common.saving', {}, language) };
    if (saveState === 'dirty') return { icon: <Clock size={12} />, text: t('common.unsaved', {}, language) };
    if (saveState === 'error') return { icon: <Clock size={12} />, text: t('common.saveFailed', {}, language) };
    return { icon: <Check size={12} />, text: t('common.saved', {}, language) };
  })();

  return (
    <div className="h-full min-h-0 bg-[#f3f3f1] dark:bg-[#181926] overflow-y-auto">
      <main className="mx-auto my-6 w-[min(960px,calc(100%-48px))] min-h-[calc(100%-48px)] rounded-lg border border-paperEdge bg-white px-10 py-9 shadow-[0_2px_4px_rgba(45,45,45,0.04),0_24px_70px_rgba(45,45,45,0.10)] dark:border-[#494d64] dark:bg-[#1e2030]">
        <header className="mb-5 border-b border-paperEdge dark:border-[#494d64] pb-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded bg-ink text-white dark:bg-[#a7c7a1] dark:text-[#24273a]">
                {card.luhmannId}
              </span>
              <span className="text-[10px] font-black uppercase tracking-widest text-muted">{t('page.markdownPage', {}, language)}</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = '';
                  void handleFiles(files);
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="zk-subtle-button border px-3 py-1.5 rounded-md text-[12px] font-bold flex items-center gap-1.5"
                title={t('page.insertAttachmentTitle', {}, language)}
              >
                <Paperclip size={12} />
                {t('page.insertAttachment', {}, language)}
              </button>
              <button
                onClick={() => void save()}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-surfaceAlt ${
                  saveState === 'error'
                    ? 'text-red-600 dark:text-red-300'
                    : saveState === 'dirty'
                      ? 'text-[#9a6a2f] dark:text-[#eed49f]'
                      : 'text-muted'
                }`}
                title={t('common.save', {}, language)}
              >
                {status.icon}
                <span>{status.text}</span>
              </button>
            </div>
          </div>
          <input
            value={draftTitle}
            onChange={(e) => {
              setDraftTitle(e.target.value);
              markDirty();
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
              }
            }}
            className="mt-3 w-full bg-white dark:bg-[#1e2030] border-0 outline-none font-display text-[38px] leading-tight font-semibold text-ink dark:text-[#cad3f5] placeholder:text-gray-300 dark:placeholder:text-[#6e738d]"
            placeholder={t('page.titlePlaceholder', {}, language)}
          />
        </header>

        <textarea
          ref={textareaRef}
          value={draftContent}
          onChange={(e) => {
            setDraftContent(e.target.value);
            markDirty();
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();
            void handleFiles(files);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            e.preventDefault();
            void handleFiles(files);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void save();
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              applyTextareaEdit(
                e.currentTarget,
                (value) => {
                  setDraftContent(value);
                  markDirty();
                },
                indentMarkdownLines(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  e.currentTarget.selectionEnd,
                  e.shiftKey ? 'out' : 'in',
                ),
              );
              return;
            }
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
              const edit = continueMarkdownList(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
                e.currentTarget.selectionEnd,
              );
              if (edit) {
                e.preventDefault();
                applyTextareaEdit(
                  e.currentTarget,
                  (value) => {
                    setDraftContent(value);
                    markDirty();
                  },
                  edit,
                );
              }
            }
          }}
          className="w-full min-h-[62vh] resize-y rounded-md bg-white dark:bg-[#1e2030] border border-transparent focus:border-paperEdge dark:focus:border-[#494d64] outline-none p-1 text-[15px] leading-[1.8] text-ink dark:text-[#cad3f5] font-mono placeholder:text-gray-300 dark:placeholder:text-[#6e738d]"
          placeholder={t('page.bodyPlaceholder', {}, language)}
        />

        <input
          value={draftTags}
          onChange={(e) => {
            setDraftTags(e.target.value);
            markDirty();
          }}
          placeholder={t('page.tagsPlaceholder', {}, language)}
          className="mt-4 w-full text-[12px] px-3 py-2 border border-paperEdge dark:border-[#494d64] rounded-md bg-white dark:bg-[#1e2030] focus:border-accent outline-none text-ink dark:text-[#cad3f5]"
        />
      </main>
    </div>
  );
}
