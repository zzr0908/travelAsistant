import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '0.0.0.0', port: 4350, strictPort: true, fs: { strict: true } },
  build: { outDir: '../../.cache/experience-preview', emptyOutDir: true },
});
