import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './index.css';

if (window.zettelDesktop?.getApiToken) {
  const nativeFetch = window.fetch.bind(window);
  const tokenPromise = window.zettelDesktop.getApiToken().catch(() => '');
  window.fetch = async (input, init = {}) => {
    const token = await tokenPromise;
    if (!token) return nativeFetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const backendOrigin = window.zettelDesktop?.backendOrigin;
    const shouldAuth =
      (backendOrigin ? url.startsWith(`${backendOrigin}/api/`) : false) ||
      url.startsWith('http://localhost:8000/api/') ||
      url.startsWith('http://127.0.0.1:8000/api/') ||
      url.startsWith('/api/');
    if (!shouldAuth) return nativeFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set('X-Folium-Token', token);
    return nativeFetch(input, { ...init, headers });
  };
}

const queryClient = new QueryClient({
  defaultOptions: {
    // staleTime: 0 → invalidate/refetch 后立即重新请求；不要用 30s 这种
    // 大的 staleTime，因为我们的 mutation 会改 vault 文件，必须立刻反映
    queries: { staleTime: 0, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
