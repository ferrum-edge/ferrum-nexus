import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { resolveDevServerPorts } from './src/lib/dev-ports';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  // The documented `.env` lives at the repo root; Vite's default envDir is `web/`.
  const { webPort, apiProxyTarget } = resolveDevServerPorts({
    ...loadEnv(mode, repoRoot, 'NEXUS_'),
    ...loadEnv(mode, repoRoot, 'VITE_'),
  });

  return {
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    server: {
      // Vite's default `localhost` resolves to `[::1]` on some hosts and to
      // `127.0.0.1` on others, so the documented http://127.0.0.1:5173 is not
      // always reachable. Bind the literal address the docs print.
      host: '127.0.0.1',
      port: webPort,
      // Fail instead of silently binding 5174 while `/api` still proxies to
      // whatever already owns 8787 (usually another Nexus stack).
      strictPort: true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      globals: false,
      coverage: {
        provider: 'v8',
        // `text` prints the summary CI captures; `lcov` writes web/coverage/lcov.info
        // for artifact upload and editor gutters. `coverage/` is git- and
        // prettier-ignored.
        reporter: ['text', 'lcov'],
        reportsDirectory: './coverage',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/**/*.d.ts',
          // Browser entrypoint: never imported by a jsdom test.
          'src/main.tsx',
        ],
      },
    },
  };
});
