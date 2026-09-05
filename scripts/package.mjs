import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const files = {};
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else files[relative(resolve(root, 'dist'), path)] = new Uint8Array(await readFile(path));
  }
}
await collect(resolve(root, 'dist'));
files['INSTALL.md'] = new Uint8Array(await readFile(resolve(root, 'docs/INSTALL.md')));
const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
for (const required of ['background.js', 'index.html', 'icons/128.png']) if (!files[required]) throw new Error(`Missing extension file: ${required}`);
if (manifest.manifest_version !== 3 || manifest.permissions.includes('webRequest') || manifest.host_permissions) throw new Error('Unexpected manifest permissions');
await mkdir(resolve(root, 'releases'), { recursive: true });
const archive = zipSync(files, { level: 9 });
await writeFile(resolve(root, `releases/BookMarker-${manifest.version}.zip`), archive);
await writeFile(resolve(root, `releases/BookMarker-${manifest.version}.sha256`), `${createHash('sha256').update(archive).digest('hex')}  BookMarker-${manifest.version}.zip\n`);
console.log(`Packaged BookMarker ${manifest.version}: ${Object.keys(files).length} files`);
