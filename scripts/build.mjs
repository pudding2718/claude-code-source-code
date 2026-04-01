#!/usr/bin/env node
/**
 * build.mjs — Best-effort build of Claude Code v2.1.88 from source
 *
 * ⚠️  IMPORTANT: A complete rebuild requires the Bun runtime's compile-time
 *     intrinsics (feature(), MACRO, bun:bundle). This script provides a
 *     best-effort build using esbuild. See KNOWN_ISSUES.md for details.
 *
 * What this script does:
 *   1. Copy src/ → build-src/ (original untouched)
 *   2. Replace `feature('X')` → `false`  (compile-time → runtime)
 *   3. Replace `MACRO.VERSION` etc → string literals
 *   4. Replace `import from 'bun:bundle'` → stub
 *   5. Create stubs for missing feature-gated modules
 *   6. Bundle with esbuild → dist/cli.js
 *
 * Requirements: Node.js >= 18, npm
 * Usage:       node scripts/build.mjs
 */

import { readdir, readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises'
import { join, dirname, basename, extname, resolve as resolvePath } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VERSION = '2.1.88'
const BUILD = join(ROOT, 'build-src')
const ENTRY = join(BUILD, 'entry.ts')
const COPY_DIRS = [
  'src',
  'stubs',
  'types',
  'tools',
  'utils',
  'assistant',
  'bridge',
  'coordinator',
  'proactive',
  'services',
  'tasks',
  'skills',
  'vendor',
]

// ── Helpers ────────────────────────────────────────────────────────────────

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory() && e.name !== 'node_modules') yield* walk(p)
    else yield p
  }
}

async function exists(p) { try { await stat(p); return true } catch { return false } }

function toPosix(p) {
  return p.replaceAll('\\', '/')
}

function makeStubSource(mod) {
  const base = basename(mod).replace(/\.[^.]+$/, '') || 'stub'
  const safeName = base.replace(/[^a-zA-Z0-9_$]/g, '_')
  return `// Auto-generated stub for ${mod}\nexport default undefined\nexport const ${safeName} = undefined\n`
}

function resolveBareModuleStubTarget(mod) {
  const parts = mod.split('/')
  if (mod.startsWith('@') && parts.length >= 2) {
    const [scope, name, ...rest] = parts
    if (rest.length === 0) {
      return join(BUILD, 'node_modules', scope, name, 'index.js')
    }
    return join(BUILD, 'node_modules', scope, name, ...rest)
  }

  const [name, ...rest] = parts
  if (rest.length === 0) {
    return join(BUILD, 'node_modules', name, 'index.js')
  }
  return join(BUILD, 'node_modules', name, ...rest)
}

function relativeStubImport(file, stubName) {
  const rel = toPosix(dirname(file).replace(`${toPosix(BUILD)}/`, ''))
  const up = rel ? '../'.repeat(rel.split('/').length) : ''
  return `${up}stubs/${stubName}`
}

function parseMissingImports(esbuildOutput) {
  const lines = esbuildOutput.split('\n')
  const missing = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/Could not resolve "([^"]+)"/)
    if (!match) continue

    let importer = null
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const importerMatch = lines[j].match(/^\s+(.+?):\d+:\d+:/)
      if (importerMatch) {
        importer = importerMatch[1]
        break
      }
    }

    missing.push({ mod: match[1], importer })
  }

  return missing
}

async function ensureEsbuild() {
  try { execSync('npx esbuild --version', { stdio: 'pipe' }) }
  catch {
    console.log('📦 Installing esbuild...')
    execSync('npm install --save-dev esbuild', { cwd: ROOT, stdio: 'inherit' })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Copy source
// ══════════════════════════════════════════════════════════════════════════════

await rm(BUILD, { recursive: true, force: true })
await mkdir(BUILD, { recursive: true })
for (const dir of COPY_DIRS) {
  const from = join(ROOT, dir)
  const to = join(BUILD, dir)
  if (await exists(from)) {
    await cp(from, to, { recursive: true })
  }
}
await writeFile(join(BUILD, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: false,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    jsx: 'react-jsx',
    baseUrl: '.',
    paths: {
      'bun:bundle': ['stubs/bun-bundle.ts'],
      'src/*': ['src/*'],
    },
    types: ['node'],
    lib: ['ES2022', 'DOM'],
  },
  include: ['src/**/*', 'stubs/**/*', 'tools/**/*', 'types/**/*', 'utils/**/*'],
}, null, 2))
console.log(`✅ Phase 1: Copied ${COPY_DIRS.join(', ')} → build-src/`)

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Transform source
// ══════════════════════════════════════════════════════════════════════════════

let transformCount = 0

// MACRO replacements
const MACROS = {
  'MACRO.VERSION': `'${VERSION}'`,
  'MACRO.BUILD_TIME': `''`,
  'MACRO.FEEDBACK_CHANNEL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.FEEDBACK_CHANNEL_URL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER_URL': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.NATIVE_PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.VERSION_CHANGELOG': `''`,
}

for await (const file of walk(BUILD)) {
  if (!file.match(/\.[tj]sx?$/)) continue

  let src = await readFile(file, 'utf8')
  let changed = false

  // 2a. feature('X') → false
  if (/\bfeature\s*\(\s*['"][^'"]+['"]\s*,?\s*\)/.test(src)) {
    src = src.replace(/\bfeature\s*\(\s*['"][^'"]+['"]\s*,?\s*\)/g, 'false')
    changed = true
  }

  // 2b. MACRO.X → literals
  for (const [k, v] of Object.entries(MACROS)) {
    if (src.includes(k)) {
      src = src.replaceAll(k, v)
      changed = true
    }
  }

  // 2c. Remove feature() imports after inlining all feature gates
  if (src.includes('feature } from') || src.includes('feature} from')) {
    src = src.replace(/import\s*\{\s*feature\s*\}\s*from\s*['"][^'"]*(?:bun:bundle|stubs\/bun-bundle\.js)['"];?\n?/g, '// feature() replaced with false at build time\n')
    changed = true
  }

  // 2d. Remove type-only import of global.d.ts
  if (src.includes('global.d.ts')) {
    src = src.replace(/import\s*['"][^'"]*global\.d\.ts['"];?\n?/g, '')
    changed = true
  }

  // 2e. Normalize import.meta.url for the CommonJS bundle
  if (src.includes('import.meta.url')) {
    src = src.replaceAll('import.meta.url', 'globalThis.__cc_import_meta_url')
    changed = true
  }

  // 2f. Rewrite private/native packages to local stubs
  const antStubReplacements = {
    '@ant/claude-for-chrome-mcp': relativeStubImport(file, 'claude-for-chrome-mcp.js'),
    '@ant/computer-use-mcp': relativeStubImport(file, 'computer-use-mcp.js'),
    '@ant/computer-use-mcp/types': relativeStubImport(file, 'computer-use-mcp-types.js'),
    '@ant/computer-use-mcp/sentinelApps': relativeStubImport(file, 'computer-use-mcp-sentinelApps.js'),
    '@ant/computer-use-input': relativeStubImport(file, 'computer-use-input.js'),
    '@ant/computer-use-swift': relativeStubImport(file, 'computer-use-swift.js'),
    'color-diff-napi': relativeStubImport(file, 'color-diff-napi.js'),
    'image-processor-napi': relativeStubImport(file, 'image-processor-napi.js'),
    'modifiers-napi': relativeStubImport(file, 'modifiers-napi.js'),
  }
  for (const [from, to] of Object.entries(antStubReplacements)) {
    if (src.includes(from)) {
      src = src.replaceAll(from, to)
      changed = true
    }
  }

  if (changed) {
    await writeFile(file, src, 'utf8')
    transformCount++
  }
}
console.log(`✅ Phase 2: Transformed ${transformCount} files`)

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Create entry wrapper
// ══════════════════════════════════════════════════════════════════════════════

await writeFile(ENTRY, `// Claude Code v${VERSION} — built from source
// Copyright (c) Anthropic PBC. All rights reserved.
import './src/entrypoints/cli.tsx'
`, 'utf8')
console.log('✅ Phase 3: Created entry wrapper')

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Iterative stub + bundle
// ══════════════════════════════════════════════════════════════════════════════

await ensureEsbuild()

const OUT_DIR = join(ROOT, 'dist')
await mkdir(OUT_DIR, { recursive: true })
const OUT_FILE = join(OUT_DIR, 'cli.js')
await writeFile(join(OUT_DIR, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))

// Run up to 5 rounds of: esbuild → collect missing → create stubs → retry
const MAX_ROUNDS = 5
let succeeded = false

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n🔨 Phase 4 round ${round}/${MAX_ROUNDS}: Bundling...`)

  let esbuildOutput = ''
  try {
    esbuildOutput = execSync([
      'npx esbuild',
      `"${toPosix(ENTRY)}"`,
      '--bundle',
      '--platform=node',
      '--target=node18',
      '--format=cjs',
      '--tsconfig=tsconfig.json',
      `--outfile="${OUT_FILE}"`,
      `--banner:js=$'#!/usr/bin/env node\\n// Claude Code v${VERSION} (built from source)\\n// Copyright (c) Anthropic PBC. All rights reserved.\\nglobalThis.__cc_import_meta_url = require(\"url\").pathToFileURL(__filename).href;\\n'`,
      '--external:bun:*',
      '--allow-overwrite',
      '--log-level=error',
      '--log-limit=0',
      '--loader:.md=text',
      '--loader:.txt=text',
      '--sourcemap',
    ].join(' '), {
      cwd: BUILD,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    }).stderr?.toString() || ''
    succeeded = true
    break
  } catch (e) {
    esbuildOutput = (e.stderr?.toString() || '') + (e.stdout?.toString() || '')
  }

  // Parse missing modules
  const missing = parseMissingImports(esbuildOutput).filter(({ mod }) =>
    !mod.startsWith('node:') && !mod.startsWith('bun:')
  )

  if (missing.length === 0) {
    // No more missing modules but still errors — check what
    const errLines = esbuildOutput.split('\n').filter(l => l.includes('ERROR')).slice(0, 5)
    console.log('❌ Unrecoverable errors:')
    errLines.forEach(l => console.log('   ' + l))
    break
  }

  console.log(`   Found ${missing.length} missing modules, creating stubs...`)

  // Create stubs
  let stubCount = 0
  for (const { mod, importer } of missing) {
    if (!importer) continue

    const importerPath = importer.startsWith(BUILD)
      ? importer
      : resolvePath(BUILD, importer)
    const target = mod.startsWith('.')
      ? resolvePath(dirname(importerPath), mod)
      : resolveBareModuleStubTarget(mod)

    if (!target.startsWith(BUILD)) continue
    let resolvedTarget = target
    let ext = extname(resolvedTarget)
    if (!ext && !mod.startsWith('.')) {
      resolvedTarget = `${resolvedTarget}.js`
      ext = '.js'
    }

    // Text assets → empty file
    if (['.txt', '.md', '.json'].includes(ext)) {
      await mkdir(dirname(resolvedTarget), { recursive: true }).catch(() => {})
      if (!await exists(resolvedTarget)) {
        await writeFile(resolvedTarget, ext === '.json' ? '{}' : '', 'utf8')
        stubCount++
      }
      continue
    }

    // JS/TS modules → export empty
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
      await mkdir(dirname(resolvedTarget), { recursive: true }).catch(() => {})
      if (!await exists(resolvedTarget)) {
        await writeFile(resolvedTarget, makeStubSource(mod), 'utf8')
        stubCount++
      }
    }
  }
  console.log(`   Created ${stubCount} stubs`)
}

if (succeeded) {
  const size = (await stat(OUT_FILE)).size
  console.log(`\n✅ Build succeeded: ${OUT_FILE}`)
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  console.log(`\n   Usage:  node ${OUT_FILE} --version`)
  console.log(`           node ${OUT_FILE} -p "Hello"`)
} else {
  console.error('\n❌ Build failed after all rounds.')
  console.error('   The transformed source is in build-src/ for inspection.')
  console.error('\n   To fix manually:')
  console.error('   1. Check build-src/ for the transformed files')
  console.error('   2. Create missing stubs in build-src/src/')
  console.error('   3. Re-run: node scripts/build.mjs')
  process.exit(1)
}
