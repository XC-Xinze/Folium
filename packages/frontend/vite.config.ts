import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backendUrl,
      '/vault': backendUrl,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // 把重的依赖单独切出去 → 主包瘦身、浏览器并行下载、长期缓存命中率高
          'vendor-reactflow': ['@xyflow/react', 'dagre'],
          'vendor-markdown': ['marked'],
          'vendor-react': ['react', 'react-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-motion': ['framer-motion'],
        },
      },
    },
  },
});
