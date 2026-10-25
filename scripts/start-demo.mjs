import './source-loader.mjs';
import { resolve } from 'node:path';
const { startDemo } = await import('../apps/world-service/src/demo/engine.ts');

const args = process.argv.slice(2);
const parsed = new Map();
if (args.length % 2 || args.length > 4) throw new Error('Usage: pnpm demo [--data marked-directory] [--viewer-origin http://127.0.0.1:5173]');
for (let i=0;i<args.length;i+=2) {
  if (!['--data','--viewer-origin'].includes(args[i]) || parsed.has(args[i]) || !args[i+1]) throw new Error('Invalid local demo option');
  parsed.set(args[i],args[i+1]);
}
const demo = await startDemo({ directory: resolve(parsed.get('--data') ?? '.meridian-demo'), viewerOrigin: parsed.get('--viewer-origin') ?? 'http://127.0.0.1:5173' });
console.log(JSON.stringify({ mode: 'fictional-local-demo', listening: `http://127.0.0.1:${demo.port}`, paidInference: false }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { demo.close().then(() => process.exit(0), () => process.exit(1)); });
