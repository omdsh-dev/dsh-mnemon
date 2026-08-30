import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      'dsh-mnemon/client': fileURLToPath(new URL('./src/client/extension-sdk.ts', import.meta.url)),
      'dsh-mnemon-source-runtime/client': fileURLToPath(new URL('./plugins/dsh-mnemon-source-runtime/src/client.ts', import.meta.url)),
      'dsh-mnemon-source-documents/client': fileURLToPath(new URL('./plugins/dsh-mnemon-source-documents/src/client.ts', import.meta.url)),
      'dsh-mnemon-source-memory-spaces/client': fileURLToPath(new URL('./plugins/dsh-mnemon-source-memory-spaces/src/client.ts', import.meta.url)),
      'dsh-mnemon-source-memory-spaces/testing': fileURLToPath(new URL('./plugins/dsh-mnemon-source-memory-spaces/src/testing.ts', import.meta.url)),
      'dsh-mnemon-source-memory-spaces/provider-sdk': fileURLToPath(new URL('./plugins/dsh-mnemon-source-memory-spaces/src/provider-sdk.ts', import.meta.url)),
      'dsh-mnemon/extension-sdk': fileURLToPath(new URL('./packages/extension-sdk/src/index.ts', import.meta.url)),
      'dsh-mnemon/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      'dsh-mnemon/testing': fileURLToPath(new URL('./src/sdk/testing.ts', import.meta.url)),
    },
    // Source-linked DSH workspaces resolve through their real paths. Keep UI
    // packages on Mnemon's React instance just as the browser bundle does.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    coverage: { enabled: false },
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
