#!/usr/bin/env node
/**
 * Verify that the published tarball contains every runtime asset the DeepSeek
 * Harness needs: the Host entry, the bundle patch, both locales, the icon, and
 * the manifest. Run before a release or from CI.
 *
 *   node scripts/verify-package.mjs
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Read JSON that may carry a UTF-8 BOM from a Windows editor. */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const manifest = readJson(join(root, 'package.json'))
const problems = []

/** Record one packaging violation. */
function check(condition, message) {
  if (!condition) problems.push(message)
}

// --- Manifest --------------------------------------------------------------

check(manifest.private !== true, 'package.json must not set "private": true, or npm refuses to publish it')
check(typeof manifest.name === 'string' && manifest.name.length > 0, 'package.json needs a name')
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ''), `package.json version is not semver: ${JSON.stringify(manifest.version)}`)
check(manifest.type === 'module', 'package.json must stay "type": "module"')
check(manifest.publishConfig?.access === 'public', 'publishConfig.access must be "public"')
check(manifest.publishConfig?.registry === 'https://registry.npmjs.org', 'publishConfig.registry must name npmjs.com')
check(manifest.engines?.node === '>=20', 'engines.node must stay ">=20"')

const patch = manifest.dsh?.bundle?.patch
check(typeof patch === 'string' && patch.length > 0, 'package.json must declare dsh.bundle.patch')
if (typeof patch === 'string') {
  check(existsSync(join(root, patch)), `dsh.bundle.patch points at a missing file: ${patch}`)
}

for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== 'string' || target.includes('*')) continue
  check(existsSync(join(root, target)), `exports["${subpath}"] points at a missing file: ${target}`)
}

// --- Local assets ----------------------------------------------------------

const required = [
  'index.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'scripts/smoke.mjs',
  'scripts/doctor.mjs',
  'scripts/verify-package.mjs',
]
for (const relative of required) check(existsSync(join(root, relative)), `missing required file: ${relative}`)

for (const locale of ['locale/en.json', 'locale/zh.json']) {
  const file = join(root, locale)
  if (!existsSync(file)) continue
  try {
    const value = readJson(file)
    check(typeof value?.meta?.title === 'string' && value.meta.title.length > 0, `${locale} needs meta.title`)
    check(typeof value?.meta?.description === 'string' && value.meta.description.length > 0, `${locale} needs meta.description`)
  } catch (error) {
    problems.push(`${locale} is not valid JSON: ${error.message}`)
  }
}

const icon = join(root, 'icon.svg')
if (existsSync(icon)) {
  const size = statSync(icon).size
  check(size > 0 && size <= 256 * 1024, `icon.svg must be between 1 byte and 256 KiB, got ${size} bytes`)
  check(readFileSync(icon, 'utf8').includes('<svg'), 'icon.svg does not look like an SVG document')
}

// --- Packed file list ------------------------------------------------------

// Run npm with its stdout attached to a real file descriptor instead of a pipe:
// on Windows the Harness sandbox denies piped stdio, and a pipe cannot deadlock
// a large pack listing when it is a file handle.
/** Locate npm's JavaScript entry so it can run without a command shell. */
function findNpmCli() {
  const candidates = []
  if (typeof process.env.npm_execpath === 'string') candidates.push(process.env.npm_execpath)
  const nodeDir = dirname(process.execPath)
  candidates.push(
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  )
  return candidates.find((candidate) => /npm-cli\.js$/i.test(candidate) && existsSync(candidate))
}

const npmCli = findNpmCli()
const useNpmCli = npmCli !== undefined
const command = useNpmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const args = [...(useNpmCli ? [npmCli] : []), 'pack', '--dry-run', '--json', '--ignore-scripts']
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-package-'))
const packFile = join(tempDir, 'pack.json')
let packOutput
let fd
try {
  fd = openSync(packFile, 'w')
  const result = spawnSync(command, args, {
    cwd: root,
    // Keep npm's cache inside this throwaway directory: the Harness sandbox
    // cannot write the user-level cache, and CI should not depend on it either.
    env: { ...process.env, npm_config_cache: join(tempDir, 'npm-cache') },
    stdio: ['ignore', fd, 'inherit'],
    shell: !useNpmCli && process.platform === 'win32',
  })
  closeSync(fd)
  fd = undefined
  if (result.error) problems.push(`npm pack failed: ${result.error.message}`)
  else if (result.status !== 0) problems.push(`npm pack exited with status ${String(result.status)}`)
  else packOutput = readFileSync(packFile, 'utf8')
} finally {
  if (fd !== undefined) closeSync(fd)
  rmSync(tempDir, { recursive: true, force: true })
}

let packed = []
if (packOutput) {
  try {
    const [info] = JSON.parse(packOutput)
    packed = Array.isArray(info?.files) ? info.files.map((file) => file.path) : []
  } catch (error) {
    problems.push(`could not parse npm pack --json output: ${error.message}`)
  }
}

if (packed.length > 0) {
  const present = new Set(packed)
  for (const relative of required) {
    check(present.has(relative), `the packed tarball omits ${relative}; add it to package.json "files"`)
  }
  const forbidden = packed.filter((path) => path.startsWith('node_modules/') || path.startsWith('.git/') || path.includes('.tmp') || path.endsWith('.log'))
  check(forbidden.length === 0, `the packed tarball contains development files: ${forbidden.join(', ')}`)
}

if (problems.length > 0) {
  console.error('package verification failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`ok: ${manifest.name}@${manifest.version} packs ${packed.length} files with every required asset`)
