import { create } from 'zustand';

export type DialogVariant = 'default' | 'danger';

interface DialogState {
  open: boolean;
  kind: 'confirm' | 'alert' | 'prompt';
  title?: string;
  message: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  inputDefault?: string;
  inputPlaceholder?: string;
  resolve?: (value: boolean | string | null) => void;
}

export const useDialogStore = create<DialogState>(() => ({
  open: false,
  kind: 'alert',
  message: '',
}));

interface ConfirmOpts {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
}

interface AlertOpts {
  title?: string;
  description?: string;
  confirmLabel?: string;
}

interface PromptOpts {
  title?: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export const dialog = {
  confirm(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
    return new Promise((resolve) => {
      useDialogStore.setState({
        open: true,
        kind: 'confirm',
        message,
        title: opts.title,
        description: opts.description,
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
        variant: opts.variant ?? 'default',
        resolve: (v) => resolve(v === true),
      });
    });
  },
  alert(message: string, opts: AlertOpts = {}): Promise<void> {
    return new Promise((resolve) => {
      useDialogStore.setState({
        open: true,
        kind: 'alert',
        message,
        title: opts.title,
        description: opts.description,
        confirmLabel: opts.confirmLabel,
        resolve: () => resolve(),
      });
    });
  },
  prompt(message: string, opts: PromptOpts = {}): Promise<string | null> {
    return new Promise((resolve) => {
      useDialogStore.setState({
        open: true,
        kind: 'prompt',
        message,
        title: opts.title,
        description: opts.description,
        inputDefault: opts.defaultValue ?? '',
        inputPlaceholder: opts.placeholder,
        confirmLabel: opts.confirmLabel,
        resolve: (v) => resolve(typeof v === 'string' ? v : null),
      });
    });
  },
};
