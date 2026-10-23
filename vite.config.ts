import { defineConfig } from 'vite';

// Relative base so the build works under any GitHub Pages repo path.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
