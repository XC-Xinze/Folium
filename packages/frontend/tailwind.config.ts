import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // class-based dark mode：根 <html> 加 .dark 即开启
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: '#1c1b1b',
        accent: '#536253',
        accentSoft: '#d3e4d1',
        link: '#385f73',
        surface: '#f8f6f1',
        surfaceAlt: '#efebe4',
        muted: '#747878',
        // 输入区专用的纸面色（仅 NewCardBar 使用）
        paper: '#fffdf8',
        paperWarm: '#fbf8f0',
        paperEdge: '#d8d3ca',
        leaf: '#6b8e23',
      },
      boxShadow: {
        paper: '0 1px 2px rgba(45,45,45,0.04), 0 10px 28px rgba(45,45,45,0.07)',
      },
      fontFamily: {
        sans: ['var(--font-ui)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        body: ['var(--font-body)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'Newsreader', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
} satisfies Config;
