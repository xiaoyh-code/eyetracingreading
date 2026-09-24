/** Allowlisted, credential-free build for both localhost and GitHub Pages. */
import { build } from 'esbuild';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const bundle = path.join(root, 'reader/static/bundled');
const dist = path.join(root, 'dist');
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
// Refresh the exact manifest from the pinned, integrity-verified upstream
// package on every build. An ignored local vendor folder is not a release list.
execFileSync('python3', ['scripts/prepare_webgazer.py'], { stdio: 'inherit' });

await build({
  entryPoints: { app: 'reader/static/app.js', 'translation-worker': 'reader/static/translation-worker.js' },
  outdir: bundle, bundle: true, splitting: true, format: 'esm', platform: 'browser',
  target: ['es2022'], sourcemap: false, minify: true, legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
await mkdir(`${bundle}/vendor/onnx`, { recursive: true });
for (const file of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm-simd-threaded(?:\.jsep)?\.(?:wasm|mjs)$/.test(file)) await cp(`node_modules/onnxruntime-web/dist/${file}`, `${bundle}/vendor/onnx/${file}`);
}
await mkdir(`${bundle}/vendor/pdfjs`, { recursive: true });
await cp('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', `${bundle}/vendor/pdfjs/pdf.worker.min.mjs`);
await cp('node_modules/pdfjs-dist/cmaps', `${bundle}/vendor/pdfjs/cmaps`, { recursive: true });
await cp('node_modules/pdfjs-dist/standard_fonts', `${bundle}/vendor/pdfjs/standard_fonts`, { recursive: true });
await cp('node_modules/pdfjs-dist/wasm', `${bundle}/vendor/pdfjs/wasm`, { recursive: true });

// Import only the authored demo module: never import the app or load .env.
const demo = execFileSync('python3', ['-c', 'import json,runpy;d=runpy.run_path("reader/demo.py");print(json.dumps({"TEXT":d["TEXT"],"TITLE":d["TITLE"],"TRANSLATIONS":d["TRANSLATIONS"],"GLOSSARY":d["DICTIONARY"]},ensure_ascii=False))']);
await writeFile(`${bundle}/browser-data.json`, demo);

// Include full notices for the installed packages rather than stripping legal comments.
const licenses = [];
async function packageNotices(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) { await packageNotices(folder); continue; }
    if (!existsSync(path.join(folder, 'package.json'))) continue;
    const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
    const files = (await readdir(folder)).filter(file => /^(license|copying|notice)(\.|$)/i.test(file));
    licenses.push(`\n\n## ${pkg.name}@${pkg.version}\n${pkg.license || 'See package license'}\nSource: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`);
    for (const file of files) {
      try { licenses.push(await readFile(path.join(folder, file), 'utf8')); } catch { /* License directory, not a file. */ }
    }
    if (existsSync(path.join(folder, 'node_modules'))) await packageNotices(path.join(folder, 'node_modules'));
  }
}
await packageNotices('node_modules');
await writeFile(`${bundle}/DEPENDENCY-LICENSES.txt`, licenses.join('\n'));

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/static`, { recursive: true });
const html = (await readFile('reader/static/index.html', 'utf8')).replace('name="reader-runtime" content="local"', 'name="reader-runtime" content="browser"');
await writeFile(`${dist}/index.html`, html);
for (const file of ['style.css', 'gaze.css']) await cp(`reader/static/${file}`, `${dist}/static/${file}`);
await cp(bundle, `${dist}/static/bundled`, { recursive: true });
const vendor = path.join(root, 'reader/static/vendor');
const manifest = JSON.parse(await readFile(path.join(vendor, 'WEBGAZER-MANIFEST.json'), 'utf8'));
if (manifest.version !== '3.5.3' || !Array.isArray(manifest.files)) throw new Error('Invalid verified WebGazer manifest.');
const copied = new Set();
const sourceAssets = ['source/webgazer-3.5.3-source.tar.gz', 'source/webgazer-3.5.3-npm.tgz', 'source/WEBGAZER-SOURCE.json'];
for (const entry of manifest.files) {
  const relative = entry.path;
  if (typeof relative !== 'string' || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !(['webgazer.js', 'WEBGAZER-LICENSE.md', 'WEBGAZER-VERSION.txt', ...sourceAssets].includes(relative)
          || relative.startsWith('mediapipe/face_mesh/'))
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || copied.has(relative)) {
    throw new Error('Unexpected WebGazer manifest entry.');
  }
  const source = path.join(vendor, relative);
  for (let current = source; current !== path.dirname(vendor); current = path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('WebGazer release assets cannot be symlinks.');
  }
  if (!(await lstat(source)).isFile()) throw new Error('WebGazer release asset must be a regular file.');
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('WebGazer asset integrity check failed.');
  // Source archives are public downloads, separate from application runtime.
  const target = relative.startsWith('source/') ? path.join(dist, relative) : path.join(dist, 'static/vendor', relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  copied.add(relative);
}
if (!['webgazer.js', 'WEBGAZER-LICENSE.md', 'WEBGAZER-VERSION.txt', ...sourceAssets].every(file => copied.has(file))) {
  throw new Error('WebGazer release is missing required runtime/license files.');
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(file, `${dist}/${file}`);
await writeFile(`${dist}/.nojekyll`, '');

// Cache only our enumerated public assets; never intercept provider requests or keys.
async function filesBelow(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), `${relative}/`));
    else files.push(relative);
  }
  return files;
}
const files = await filesBelow(dist);
const digest = createHash('sha256');
for (const file of files.sort()) { digest.update(file); digest.update(await readFile(`${dist}/${file}`)); }
const version = digest.digest('hex').slice(0, 16);
const core = files.filter(file => file === 'index.html' || file.endsWith('.css') || /^static\/bundled\/[^/]+\.(js|json)$/.test(file));
await writeFile(`${dist}/sw.js`, `// Public application assets only; credentials and documents are never cached.\nconst prefix='gaze-reader:'+self.registration.scope;\nconst cacheName=prefix+${JSON.stringify(version)};\nconst allowed=new Set(${JSON.stringify(files)}.map(p=>new URL(p,self.registration.scope).href));\nconst core=${JSON.stringify(core)};\nself.addEventListener('install',e=>e.waitUntil(caches.open(cacheName).then(c=>c.addAll(core.map(p=>new URL(p,self.registration.scope).href)))));\nself.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(prefix)&&k!==cacheName).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));\nself.addEventListener('fetch',e=>{\n const r=e.request;if(r.method!=='GET'||r.headers.has('Authorization'))return;\n let u=new URL(r.url);if(u.search)return;\n if(r.mode==='navigate'&&u.href===self.registration.scope)u=new URL('index.html',self.registration.scope);\n if(!allowed.has(u.href))return;\n e.respondWith(caches.open(cacheName).then(async c=>{\n  const old=await c.match(u.href);if(old)return old;\n  const result=await fetch(r);if(result.ok&&result.type!=='opaque')await c.put(u.href,result.clone());return result;\n }));\n});\n`);
console.log(`Built public Pages site in dist/ and local bundles in reader/static/bundled/ (${version}). No environment files included.`);
