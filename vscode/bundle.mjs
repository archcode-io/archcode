// Bundles the extension with the engine (and ELK) into one CommonJS file for the extension host.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/extension.js'], bundle: true, platform: 'node', format: 'cjs', target: ['node18'],
  external: ['vscode'], outfile: 'dist/extension.js', minify: true, logLevel: 'error',
});
console.log('dist/extension.js');
