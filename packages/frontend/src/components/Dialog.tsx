import { useEffect, useRef, useState } from 'react';
import { useDialogStore } from '../lib/dialog';

export function Dialog() {
  const state = useDialogStore();
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.open && state.kind === 'prompt') {
      setInput(state.inputDefault ?? '');
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
      return () => window.clearTimeout(t);
    }
  }, [state.open, state.kind, state.inputDefault]);

  if (!state.open) return null;

  const close = (result: boolean | string | null) => {
    state.resolve?.(result);
    useDialogStore.setState({ open: false, resolve: undefined });
  };

  const isPrompt = state.kind === 'prompt';
  const isAlert = state.kind === 'alert';
  const confirmLabel = state.confirmLabel ?? (isAlert ? 'OK' : 'Confirm');
  const cancelLabel = state.cancelLabel ?? 'Cancel';
  const isDanger = state.variant === 'danger';

  const onConfirm = () => close(isPrompt ? input : true);
  const onCancel = () => close(isPrompt ? null : false);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[440px] max-w-[90vw] p-5 border border-gray-200"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !isPrompt) onConfirm();
        }}
        tabIndex={-1}
      >
        {state.title && (
          <h3 className="text-sm font-bold mb-2 text-ink">{state.title}</h3>
        )}
        <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
          {state.message}
        </p>
        {state.description && (
          <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">
            {state.description}
          </p>
        )}
        {isPrompt && (
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={state.inputPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
            className="mt-3 w-full px-2 py-1.5 border border-gray-300 rounded outline-none focus:border-accent text-sm"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          {!isAlert && (
            <button
              onClick={onCancel}
              className="text-xs font-bold px-3 py-1.5 rounded text-gray-600 hover:bg-gray-100 transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            autoFocus={!isPrompt}
            className={`text-xs font-bold px-3 py-1.5 rounded text-white transition-colors ${
              isDanger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-accent hover:bg-accent/90'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
