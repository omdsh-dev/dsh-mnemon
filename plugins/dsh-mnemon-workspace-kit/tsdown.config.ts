import { defineConfig } from 'tsdown'
export default defineConfig({ entry: ['src/index.ts', 'src/client.tsx', 'src/dsh.ts'], outDir: 'lib', format: 'esm', target: 'es2024', dts: true, clean: true, fixedExtension: false, deps: { neverBundle: true } })
