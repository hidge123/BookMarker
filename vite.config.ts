import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'chrome134',
    rollupOptions: {
      input: { manager: resolve(import.meta.dirname, 'index.html'), background: resolve(import.meta.dirname, 'src/background.ts') },
      output: { entryFileNames: info => info.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js' },
    },
  },
});
