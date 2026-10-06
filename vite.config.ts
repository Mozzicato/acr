import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './server/plugin.js';

export default defineConfig(({ mode }) => {
  // Server-side only: nothing loaded here is exposed to the browser bundle.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), apiPlugin(env)],
    build: {
      rollupOptions: {
        input: { console: resolve(import.meta.dirname, 'index.html'), app: resolve(import.meta.dirname, 'app/index.html') },
      },
    },
    worker: { format: 'es' },
    test: { include: ['src/**/*.test.ts'] },
  };
});
