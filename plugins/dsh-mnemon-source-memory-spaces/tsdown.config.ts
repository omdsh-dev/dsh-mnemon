import { defineConfig } from 'tsdown'

export default defineConfig([
{
  entry: ['src/index.ts', 'src/provider-sdk.ts', 'src/testing.ts'], outDir: 'lib', format: 'esm', platform: 'node',
  target: 'es2024', dts: true, clean: true, fixedExtension: false, deps: { neverBundle: true },
},
{
  entry: { client: 'src/client.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser',
  target: 'es2022', dts: false, clean: false, fixedExtension: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { neverBundle: true },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mnemon-source-memory-spaces", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
},
])
