import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { agentProxy } from './server/agentProxy';

export default defineConfig(({ mode }) => {
  // Load all variables (not just VITE_*) for the server side only; nothing here is exposed to the client.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), agentProxy(env.GROQ_API_KEY)],
    test: { include: ['src/**/*.test.ts'] },
  };
});
