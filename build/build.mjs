// ---------------------------------------------------------------------------
// build/build.mjs — the whole client build.
//
// One process, esbuild only. There is no dev server, no hosting target and no
// Vercel in this path: the output is a static dist/ that server/index.js serves
// itself (see server/run-host.js). `npm run build && npm start` is the entire
// story.
//
// What this file has to reproduce, because the source relies on it:
//
//   ?url / ?raw        asset imports. Mapped to esbuild's built-in `file`
//                      namespace (which copies the file and exports its URL) and
//                      to a text namespace respectively.
//   import.meta.glob   one call site, src/sky/skyboxCatalog.js. Expanded by
//                      walking the tree at build time; the faces are copied to
//                      dist/assets/sky and the call is replaced by the literal
//                      map Vite would have produced.
//   import.meta.env    replaced by a frozen object, same keys Vite exposed.
//   worker URL         `new URL('./x.worker.js', import.meta.url)` is not
//                      something esbuild understands, so workers are pre-built
//                      (pass one) and the call site is rewritten to the emitted
//                      filename (pass two).
//   two three.js       the 3D island renders with three/webgpu while the trainer
//                      renders with the WebGL build, and one addon file cannot
//                      be both. Ported from the old vite.config.js: the bare
//                      `three/examples/jsm/...` specifier is the island's and is
//                      loaded in the WebGPU namespace, `...?three-webgl` is the
//                      trainer's copy and is loaded in the WebGL namespace.
//                      esbuild namespaces are what make two instances of one
//                      file possible, which is all Vite's dual resolve did.
//
// Code splitting is deliberately OFF. Every page is one JS file plus one CSS
// file, and every dynamic import() is inlined into its page. That costs bundle
// size and buys: lazy views can no longer arrive with their own stylesheet
// (esbuild emits a chunk's CSS but nothing loads it, and the app has no runtime
// CSS loader), and the page never has to fetch a second file to render.
// ---------------------------------------------------------------------------

import '../server/env.js';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const ASSETS = path.join(OUT, 'assets');
const TMP = path.join(ROOT, 'build', '.tmp');

const argv = new Set(process.argv.slice(2));
const MINIFY = !argv.has('--no-minify');

/** Pages. `html` is copied to dist/ at the same path with its tags rewritten. */
const PAGES = [
  { name: 'index', html: 'index.html' },
  { name: 'train', html: 'train.html' },
  { name: 'cs3d', html: 'cs3d.html' },
  { name: 'football', html: 'tools/football.html' },
  { name: 'zone-editor', html: 'tools/zone-editor.html' },
  { name: 'sim-view', html: 'tools/sim-view.html' }
];

const log = (...args) => console.log('[build]', ...args);
const warn = (...args) => console.warn('[build]', ...args);

function hash(contents, len = 8) {
  return crypto.createHash('sha256').update(contents).digest('hex').slice(0, len);
}

function clean() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
}

// ---------------------------------------------------------------------------
// import.meta.env
// ---------------------------------------------------------------------------

/** The VITE_-prefixed half of the environment, plus Vite's own constants. */
function clientEnv() {
  const env = {
    MODE: 'production',
    DEV: false,
    PROD: true,
    SSR: false,
    BASE_URL: '/'
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITE_')) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

/**
 * `/src/x.js` is a project-root path in this codebase, not a filesystem root,
 * and `/fonts/x.woff2` is a public/ path the static server already answers.
 * The first is resolved, the second is left exactly as written, which is what
 * Vite did with it.
 */
function rootPaths() {
  return {
    name: 'aim4-root-paths',
    setup(build) {
      build.onResolve({ filter: /^\// }, (args) => {
        if (args.namespace !== 'file') return null;
        const rel = args.path.slice(1);
        const abs = path.join(ROOT, rel);
        if (fs.existsSync(abs)) return { path: abs };
        // Source paths are never public assets, so a miss there is a typo and
        // must not quietly become a runtime 404.
        if (/^(src|server|shared|build)\//.test(rel)) {
          throw new Error(`cannot resolve ${args.path} from ${path.relative(ROOT, args.resolveDir || ROOT)}`);
        }
        // Everything else (/fonts, /icons, /maps) is public/ and the static
        // server already answers it. Left exactly as written, as Vite did.
        return { external: true };
      });
    }
  };
}

/** The webgpu build imports a debug shim over https when it is not bundled. */
function externalUrls() {
  return {
    name: 'aim4-external-urls',
    setup(build) {
      build.onResolve({ filter: /^(https?:)?\/\// }, () => ({ external: true }));
    }
  };
}

const QUERY = /\?(raw|url)$/;

/** Extensions that mean "copy the file, export its URL", the way Vite does. */
const ASSET_LOADERS = {
  '.svg': 'file',
  '.png': 'file',
  '.jpg': 'file',
  '.jpeg': 'file',
  '.gif': 'file',
  '.webp': 'file',
  '.avif': 'file',
  '.ico': 'file',
  '.cur': 'file',
  '.otf': 'file',
  '.ttf': 'file',
  '.woff': 'file',
  '.woff2': 'file',
  '.eot': 'file',
  '.mp3': 'file',
  '.ogg': 'file',
  '.wav': 'file',
  '.glb': 'file',
  '.gltf': 'file',
  '.bin': 'file',
  '.hdr': 'file',
  '.ktx2': 'file',
  '.basis': 'file',
  '.wasm': 'file',
  '.glsl': 'text',
  '.vert': 'text',
  '.frag': 'text',
  '.wgsl': 'text'
};

/** `?url` and `?raw`, which is every query this source uses. */
function assetQueries() {
  return {
    name: 'aim4-asset-queries',
    setup(build) {
      build.onResolve({ filter: QUERY }, (args) => {
        const kind = args.path.slice(args.path.lastIndexOf('?') + 1);
        const clean = args.path.slice(0, args.path.lastIndexOf('?'));
        const abs = clean.startsWith('/')
          ? path.join(ROOT, clean.slice(1))
          : path.resolve(args.resolveDir, clean);
        // `file` is esbuild's own: it copies the asset next to the bundle and
        // exports its path, which is exactly what ?url means here.
        return { path: abs, namespace: kind === 'url' ? 'file' : 'aim4-raw' };
      });
      build.onLoad({ filter: /.*/, namespace: 'aim4-raw' }, (args) => ({
        contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))};`,
        loader: 'js'
      }));
    }
  };
}

// --- import.meta.glob --------------------------------------------------------

function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const out = [];
  let current = '';
  let inner = 0;
  for (const ch of body) {
    if (ch === '{') inner++;
    if (ch === '}') inner--;
    if (ch === ',' && inner === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.flatMap((part) => expandBraces(head + part + tail));
}

/** A './a/b/px.png' pattern compiled to a matcher, relative to the importer. */
function matcher(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Copy a build-discovered asset and return the URL it will be served under. */
function emitAsset(file, subdir = '') {
  const bytes = fs.readFileSync(file);
  const name = `${path.basename(file, path.extname(file))}-${hash(bytes)}${path.extname(file)}`;
  const dir = subdir ? path.join(ASSETS, subdir) : ASSETS;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return `/assets/${subdir ? `${subdir}/` : ''}${name}`;
}

/**
 * The one import.meta.glob in the source (src/sky/skyboxCatalog.js).
 *
 * Only `eager: true` with `query: '?url'` and `import: 'default'` is supported,
 * because that is the only shape used. The faces land in dist/assets/sky and the
 * call is replaced by the object literal Vite would have handed it, keyed by the
 * same './Folder/sky_1_2k/px.png' paths the catalog parses.
 */
function globImports() {
  return {
    name: 'aim4-glob',
    setup(build) {
      build.onLoad({ filter: /skyboxCatalog\.js$/ }, (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        if (!source.includes('import.meta.glob')) return null;

        const call = /import\.meta\.glob\(\s*'([^']+)'\s*,\s*(\{[\s\S]*?\})\s*\)/.exec(source);
        if (!call) {
          throw new Error(`${args.path}: unsupported import.meta.glob form`);
        }
        const options = call[2];
        if (!/eager:\s*true/.test(options) || !/query:\s*'\?url'/.test(options)) {
          throw new Error(`${args.path}: only eager ?url globs are supported`);
        }

        const dir = path.dirname(args.path);
        const files = walk(dir);
        const map = {};
        for (const expanded of expandBraces(call[1])) {
          const rel = expanded.replace(/^\.\//, '');
          const re = matcher(rel);
          for (const file of files) {
            const key = `./${path.relative(dir, file).split(path.sep).join('/')}`;
            if (!re.test(key.slice(2))) continue;
            map[key] = emitAsset(file, 'sky');
          }
        }
        const literal = `{${Object.entries(map)
          .map(([key, url]) => `${JSON.stringify(key)}:${JSON.stringify(url)}`)
          .join(',')}}`;
        return {
          contents: source.replace(/import\.meta\.glob\([\s\S]*?\)\s*;?/, literal),
          loader: 'js',
          resolveDir: dir
        };
      });
    }
  };
}

// --- two three.js builds -----------------------------------------------------

const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const THREE_WEBGL = path.join(THREE_DIR, 'build', 'three.module.js');
const THREE_WEBGPU = path.join(THREE_DIR, 'build', 'three.webgpu.js');
const FLAVORS = { 'three-webgl': THREE_WEBGL, 'three-webgpu': THREE_WEBGPU };
const JSM = /^three\/(?:examples\/jsm|addons)\//;

/**
 * The addons that follow the island onto the WebGPU build, from the old
 * vite.config.js. The list is short on purpose: the webgpu build does not
 * export everything the WebGL one does (UniformsUtils is the one that bites, and
 * the postprocessing passes need it), so every other addon stays on WebGL.
 */
const WEBGPU_ADDONS = new Set([
  'loaders/GLTFLoader.js',
  'loaders/RGBELoader.js',
  'utils/SkeletonUtils.js'
]);

function threeFlavors() {
  return {
    name: 'aim4-three-flavors',
    setup(build) {
      // A flavor's own relative imports stay inside that flavor, so the island's
      // copy of a helper never silently resolves to the trainer's three.
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.namespace !== 'three-webgl' && args.namespace !== 'three-webgpu') return null;
        return { path: path.resolve(args.resolveDir, args.path), namespace: args.namespace };
      });

      build.onResolve({ filter: /^three(\/|$)/ }, (args) => {
        const webglCopy = args.path.endsWith('?three-webgl');
        const spec = webglCopy ? args.path.slice(0, -'?three-webgl'.length) : args.path;

        if (spec === 'three/webgpu' || spec === 'three/tsl') {
          return { path: THREE_WEBGPU, namespace: 'three-webgpu' };
        }
        if (spec === 'three') {
          const namespace = args.namespace === 'three-webgpu' ? 'three-webgpu' : 'three-webgl';
          return { path: FLAVORS[namespace], namespace };
        }
        if (JSM.test(spec)) {
          // The bare specifier belongs to the island when it is one of the
          // addons that follow it onto the WebGPU build; everything else, and
          // every `?three-webgl` copy, is the trainer's WebGL one.
          const rel = spec.replace(JSM, '');
          const namespace = !webglCopy && WEBGPU_ADDONS.has(rel) ? 'three-webgpu' : 'three-webgl';
          return { path: path.join(THREE_DIR, 'examples', 'jsm', rel), namespace };
        }
        return null;
      });

      for (const namespace of Object.keys(FLAVORS)) {
        build.onLoad({ filter: /.*/, namespace }, (args) => ({
          contents: fs.readFileSync(args.path, 'utf8'),
          loader: 'js',
          resolveDir: path.dirname(args.path)
        }));
      }
    }
  };
}

// --- workers -----------------------------------------------------------------

const WORKER_CALL = /new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.worker\.js)\1\s*,\s*import\.meta\.url\s*\)/g;

/** Every `new URL('./x.worker.js', import.meta.url)` in the source. */
function findWorkers() {
  const workers = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(WORKER_CALL)) {
      workers.push({ importer: file, ref: path.resolve(path.dirname(file), match[2]) });
    }
  }
  return workers;
}

/** Pass one: the worker bundles, so pass two can name them. */
async function buildWorkers(workers) {
  const urls = new Map();
  if (!workers.length) return urls;

  const result = await esbuild.build({
    entryPoints: [...new Set(workers.map((w) => w.ref))],
    outdir: path.join(ASSETS, 'workers'),
    entryNames: '[name]-[hash]',
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: MINIFY,
    metafile: true,
    absWorkingDir: ROOT,
    loader: ASSET_LOADERS,
    define: { 'import.meta.env': JSON.stringify(clientEnv()) },
    plugins: [rootPaths(), externalUrls(), assetQueries()]
  });
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    urls.set(path.resolve(ROOT, meta.entryPoint), `/assets/workers/${path.basename(out)}`);
  }
  return urls;
}

function workerRewrites(urls) {
  return {
    name: 'aim4-workers',
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (args) => {
        if (!urls.size || args.namespace !== 'file') return null;
        const source = fs.readFileSync(args.path, 'utf8');
        if (!source.includes('.worker.js')) return null;
        let changed = false;
        const contents = source.replace(WORKER_CALL, (whole, _q, ref) => {
          const url = urls.get(path.resolve(path.dirname(args.path), ref));
          if (!url) return whole;
          changed = true;
          return `new URL(${JSON.stringify(url)}, import.meta.url)`;
        });
        return changed ? { contents, loader: 'js' } : null;
      });
    }
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A page entry that imports the page's stylesheets and then the page's script,
 * so the page is one JS file and one CSS file with no duplicates and no
 * load-order guesswork. Written to build/.tmp because the imports are absolute
 * project paths and the file is not at the project root.
 */
function pageEntry(page, html) {
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
    .map((tag) => /href="([^"]+)"/.exec(tag[0])?.[1])
    .filter((href) => href && href.startsWith('/src/'));
  const scripts = [...html.matchAll(/<script[^>]+type="module"[^>]*>/g)]
    .map((tag) => /src="([^"]+)"/.exec(tag[0])?.[1])
    .filter(Boolean);
  const inline = /<script[^>]+type="module"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? null;

  if (inline !== null) {
    const file = path.join(TMP, `${page.name}.inline.mjs`);
    fs.writeFileSync(file, inline);
    scripts.push(`/${path.relative(ROOT, file).split(path.sep).join('/')}`);
  }
  if (!scripts.length) throw new Error(`${page.html}: no module script found`);

  const file = path.join(TMP, `${page.name}.entry.mjs`);
  fs.writeFileSync(file, `${[...styles, ...scripts].map((s) => `import ${JSON.stringify(s)};`).join('\n')}\n`);
  return { file, styles, scripts, hasInline: inline !== null };
}

function rewriteHtml(html, js, css) {
  let out = html
    .replace(/<link[^>]+rel="stylesheet"[^>]*>/g, '')
    .replace(/<script[^>]+type="module"[^>]*><\/script>/g, '');
  const tags = [
    ...(css ? [`<link rel="stylesheet" href="${css}" />`] : []),
    `<script type="module" src="${js}"></script>`
  ].join('\n');
  return out.replace('</body>', `  ${tags}\n</body>`);
}

// ---------------------------------------------------------------------------
// public/
// ---------------------------------------------------------------------------

function copyPublic() {
  const from = path.join(ROOT, 'public');
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  for (const file of walk(from)) {
    const rel = path.relative(from, file);
    if (path.basename(rel) === '.DS_Store') continue;
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

const PLUGINS = [
  rootPaths(),
  externalUrls(),
  assetQueries(),
  globImports(),
  threeFlavors()
];

async function run() {
  clean();

  const workers = findWorkers();
  const workerUrls = await buildWorkers(workers);
  if (workers.length) log(`workers: ${workerUrls.size}`);

  const pages = PAGES.map((page) => {
    const html = fs.readFileSync(path.join(ROOT, page.html), 'utf8');
    return { page, html, ...pageEntry(page, html) };
  });

  const result = await esbuild.build({
    entryPoints: pages.map((p) => p.file),
    outdir: ASSETS,
    entryNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: MINIFY,
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    absWorkingDir: ROOT,
    loader: ASSET_LOADERS,
    define: { 'import.meta.env': JSON.stringify(clientEnv()) },
    plugins: [...PLUGINS, workerRewrites(workerUrls)]
  });

  // Output paths per entry. A JS entry names its own stylesheet through
  // cssBundle, and the two are hashed independently, so the stylesheet is looked
  // up rather than derived from the script's name.
  const outputs = new Map();
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint || !out.endsWith('.js')) continue;
    outputs.set(path.resolve(ROOT, meta.entryPoint), { js: out, css: meta.cssBundle || null });
  }

  for (const { page, html, file, hasInline } of pages) {
    const out = outputs.get(path.resolve(file)) || {};
    if (!out.js) throw new Error(`${page.html}: no bundle produced`);
    const rel = (p) => `/${path.relative(OUT, path.resolve(ROOT, p)).split(path.sep).join('/')}`;
    const js = rel(out.js);
    // A page with no stylesheet of its own (football carries its CSS inline).
    const css = out.css ? rel(out.css) : null;
    const dest = path.join(OUT, page.html);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewriteHtml(html, js, css));
    if (hasInline) fs.rmSync(path.join(TMP, `${page.name}.inline.mjs`), { force: true });
    fs.rmSync(file, { force: true });

    const kB = (p) =>
      p ? `${(fs.statSync(path.join(OUT, p)).size / 1024).toFixed(0)} kB` : 'none';
    log(`${page.html.padEnd(24)} js ${kB(js)}  css ${kB(css)}`);
  }

  log(`public files copied: ${copyPublic()}`);
  log(`done in ${((Date.now() - STARTED) / 1000).toFixed(1)}s`);
}

const STARTED = Date.now();
await run();
