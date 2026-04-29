const DESKTOP_BACKEND_ORIGIN = 'http://127.0.0.1:8000';

export function backendOrigin(): string {
  if (typeof window === 'undefined') return '';
  if (window.location.protocol === 'file:' || window.zettelDesktop) {
    return DESKTOP_BACKEND_ORIGIN;
  }
  return '';
}

export const API_BASE = `${backendOrigin()}/api`;
export const VAULT_BASE = `${backendOrigin()}/vault`;
