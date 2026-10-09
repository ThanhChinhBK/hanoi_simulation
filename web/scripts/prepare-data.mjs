// Copies the city bundle, baseline routes and example scenarios into public/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');

const files = [
  { src: join(repo, 'data/bundles/hanoi-inner.json'), dst: join(web, 'public/data/hanoi-inner.json'), hint: 'build it with the pipeline (see the repo README: pipeline → data/bundles/hanoi-inner.json)' },
  { src: join(repo, 'data/out/routes.bin'), dst: join(web, 'public/data/routes.bin'), hint: 'compute it with the CLI baseline run (see the repo README: hanoi-sim baseline … writes data/out/routes.bin)' },
];

let failed = false;
for (const f of files) {
  if (!existsSync(f.src)) {
    console.error(`prepare-data: missing ${f.src}\n  → ${f.hint}`);
    failed = true;
    continue;
  }
  mkdirSync(dirname(f.dst), { recursive: true });
  const fresh = existsSync(f.dst) && statSync(f.dst).mtimeMs >= statSync(f.src).mtimeMs && statSync(f.dst).size === statSync(f.src).size;
  if (!fresh) copyFileSync(f.src, f.dst);
  console.log(`prepare-data: ${fresh ? 'up to date' : 'copied'} ${f.dst.slice(web.length + 1)}`);
}

const scenSrc = join(repo, 'scenarios');
const scenDst = join(web, 'public/scenarios');
mkdirSync(scenDst, { recursive: true });
const index = [];
if (existsSync(scenSrc)) {
  for (const name of readdirSync(scenSrc).filter((n) => n.endsWith('.json')).sort()) {
    const text = readFileSync(join(scenSrc, name), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error(`prepare-data: skipping invalid scenario ${name}: ${e}`);
      continue;
    }
    writeFileSync(join(scenDst, name), text);
    index.push({ id: name.replace(/\.json$/, ''), file: name, name: parsed.name ?? name });
  }
}
writeFileSync(join(scenDst, 'index.json'), JSON.stringify(index, null, 2));
console.log(`prepare-data: ${index.length} example scenarios → public/scenarios/`);

if (!existsSync(join(repo, 'engine-wasm/pkg/hanoi_engine_wasm.js'))) {
  console.error('prepare-data: engine-wasm/pkg is missing → run `npm run build:wasm` (needs Rust + wasm-pack)');
  failed = true;
}
if (failed) process.exit(1);
