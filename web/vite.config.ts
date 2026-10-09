/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('../engine-wasm/pkg', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  server: { fs: { allow: [repoRoot] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
