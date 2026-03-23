import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '..', 'release', 'remotestorage.js');
const sourceMap = path.resolve(root, '..', 'release', 'remotestorage.js.map');
const targetDir = path.resolve(root, 'packages', 'demo-app', 'vendor');
const target = path.resolve(targetDir, 'remotestorage.js');
const targetMap = path.resolve(targetDir, 'remotestorage.js.map');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);

if (fs.existsSync(sourceMap)) {
  fs.copyFileSync(sourceMap, targetMap);
}

console.log(`Copied ${source} -> ${target}`);
