import { createRequire, registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const admitted = new Set(JSON.parse(readFileSync(new URL('../PUBLIC-SOURCE-MANIFEST.json', import.meta.url), 'utf8')).files.map(file => file.path));
let transformSync;
function sourcePath(url) {
  const path = fileURLToPath(url);
  const local = relative(root, path).split(sep).join('/');
  if (!admitted.has(local) || realpathSync(path) !== path) throw new Error('Unadmitted source transformation');
  return path;
}
// Node26 strips ordinary TS. Only manifest-admitted TSX needs Vite's pinned synchronous transformer.
// This loader starts no child/worker, discovers no tsconfig, writes no files and grants no permissions.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
      for (const extension of ['.ts', '.tsx']) {
        try {
          const found = next(specifier.slice(0, -3) + extension, context);
          sourcePath(found.url);
          return found;
        } catch (missing) { if (missing?.code !== 'ERR_MODULE_NOT_FOUND') throw missing; }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context);
    const path = sourcePath(url);
    if (!transformSync) {
      const fromVite = createRequire(realpathSync(new URL('../apps/web/node_modules/vite/package.json', import.meta.url)));
      ({ transformSync } = fromVite('rolldown/utils'));
    }
    const result = transformSync(path, readFileSync(path, 'utf8'), {
      lang: 'tsx', target: 'es2024', jsx: { runtime: 'automatic' }, tsconfig: false, sourcemap: false
    });
    if (result.errors.length) throw new Error('Admitted TSX transformation failed');
    return { format: 'module', source: result.code, shortCircuit: true };
  }
});
