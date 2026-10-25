import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PUBLIC_ASSETS } from './public-asset-manifest.mjs';
const forbidden = /PRIVATE_ARCHIVE_CANARY|view=(?:luna-letters|intentions)|resident-[0-9]{2,3}\b|meridian-child-|ledgerBaseHash|ledgerBaseSequence|\/Users\/|file:\/\/|(?:^|["'\/])(?:archive|continuity|private-journals)(?:[\/"'])/i;
export function inspectPublicText(text, path) {
  if (forbidden.test(text)) throw Error(`forbidden public content: ${path}`);
}
function glb(bytes, path) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error(`invalid GLB: ${path}`);
  let offset = 12,
    json;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw Error('invalid GLB chunk');
    const size = bytes.readUInt32LE(offset),
      kind = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw Error('invalid GLB length');
    if (kind === 0x4e4f534a) {
      if (json) throw Error('duplicate GLB JSON');
      const text = bytes.toString('utf8', offset + 8, offset + 8 + size);
      inspectPublicText(text, path);
      json = JSON.parse(text);
    } else if (kind !== 0x004e4942) throw Error('unknown GLB chunk');
    offset += size + 8;
  }
  if (!json) throw Error('missing GLB JSON');
  const visit = v => {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (key === 'uri' && typeof value === 'string' && !/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(value)) throw Error(`external GLB URI: ${path}`);
      visit(value);
    }
  };
  visit(json);
  return json;
}
/** All files, including unreachable/orphan media, are inspected; no archive or source-map exemptions. */
export async function auditPublicArtifact(directory, {
  complete = true
} = {}) {
  const root = resolve(directory),
    inventory = [];
  const requiredLod = new Set();
  const admitted = new Map(PUBLIC_ASSETS.map(a => [a.path, a.sha256]));
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const path = resolve(dir, name),
        entry = await lstat(path),
        rel = relative(root, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw Error(`symlink in public artifact: ${rel}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const bytes = await readFile(path),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      if (extname(rel) === '.glb') {
        inspectPublicText(bytes.toString('latin1'), rel);
        const json = glb(bytes, rel);
        if (rel === 'kit/city/city.glb') for (const node of json.nodes ?? []) if (node.mesh !== undefined && node.name && node.extensions?.EXT_mesh_gpu_instancing) {
          const piece = (json.meshes?.[node.mesh]?.name ?? '').replace(/\.\d+$/, '');
          if (!/^[A-Za-z0-9_-]+$/.test(piece)) throw Error('invalid city LOD piece');
          requiredLod.add(piece === 'quay_cypress' ? 'kit/civic/kit_civic_planter_cypress_std.glb' : `kit/street/${piece}.glb`);
        }
      } else inspectPublicText(bytes.toString('utf8'), rel);
      if (admitted.has(rel)) {
        if (sha256 !== admitted.get(rel)) throw Error(`changed admitted asset: ${rel}`);
      } else if (!/^(?:index\.html|manifest\.webmanifest|sw\.js|assets\/index-[A-Za-z0-9_-]{8}\.(?:js|css))$/.test(rel)) throw Error(`unadmitted public file: ${rel}`);
      if (rel.endsWith('.svg') && /(?:href=["\'](?:https?:|file:)|<script|onload=)/i.test(bytes.toString())) throw Error(`active SVG: ${rel}`);
      if (rel === 'manifest.webmanifest') {
        const m = JSON.parse(bytes.toString());
        for (const icon of m.icons ?? []) if (!admitted.has(icon.src.replace(/^\//, ''))) throw Error('unadmitted manifest icon');
        if (m.start_url && m.start_url !== '/') throw Error('unadmitted manifest start URL');
      }
      inventory.push({
        path: rel,
        sha256,
        bytes: bytes.length
      });
    }
  }
  await walk(root);
  if (complete) {
    const present = new Set(inventory.map(file => file.path));
    for (const path of ['index.html', 'manifest.webmanifest', 'sw.js', ...PUBLIC_ASSETS.map(file => file.path), ...requiredLod]) if (!present.has(path)) throw Error(`missing required public file: ${path}`);
    const html = await readFile(resolve(root, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const path = match[1].replace(/^\//, '');
      if (!present.has(path)) throw Error(`missing or external HTML resource: ${path}`);
    }
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const files = await auditPublicArtifact(process.argv[2] ?? 'apps/web/dist');
    console.log(`PUBLIC_ARTIFACT_PASS ${files.length} files; local privacy/closure check only, publication rights unresolved`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
