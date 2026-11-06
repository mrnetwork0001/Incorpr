import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0A0B0D',
        panel: '#111318',
        line: '#262931',
        paper: '#ECE9E2',
        dim: '#A2A4AB',
        link: '#A9C1EC',
        free: '#4ADE80',
        listed: '#F5B544',
        pledged: '#BB9AF7',
        danger: '#F87171',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
