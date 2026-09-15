import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@kairo/driver': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', '**/*.d.ts'],
    },
  },
});
