import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1f2933',
        accent: '#7c4dff',
        accentSoft: '#ede9fe',
        // 输入区专用的纸面色（仅 NewCardBar 使用）
        paper: '#fdfcf9',
        paperEdge: '#e8e4dc',
        leaf: '#5b8c5a',
      },
      boxShadow: {
        paper: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
} satisfies Config;
