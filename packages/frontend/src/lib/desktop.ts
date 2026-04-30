export interface ZettelDesktopApi {
  getApiToken(): Promise<string>;
  selectDirectory(options?: {
    title?: string;
    buttonLabel?: string;
    createDirectory?: boolean;
  }): Promise<string | null>;
}

declare global {
  interface Window {
    zettelDesktop?: ZettelDesktopApi;
  }
}

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && !!window.zettelDesktop;
}

export async function selectVaultDirectory(options?: {
  title?: string;
  buttonLabel?: string;
  createDirectory?: boolean;
}): Promise<string | null> {
  return window.zettelDesktop?.selectDirectory(options) ?? null;
}
