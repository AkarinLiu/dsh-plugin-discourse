#!/usr/bin/env node
/**
 * Diagnose (and with --fix, remove) the Windows install trap where a stale
 * directory junction for this bundle blocks a registry install:
 *
 *   [ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-plugin-discourse]
 *   EPERM: operation not permitted, rename '..._tmp_...' -> '...dsh-plugin-discourse'
 *
 * A local-clone install (dsh plugin add ./dsh-plugin-discourse) creates that
 * junction. pnpm's hoisted linker does not always record or prune it, so a
 * later npm install cannot replace it. Removing the junction removes only the
 * link; the checkout it points at is left untouched.
 *
 *   node scripts/doctor.mjs --profile desktop
 *   node scripts/doctor.mjs --profile desktop --fix
 */

import { readFileSync, existsSync, lstatSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PACKAGE = 'dsh-plugin-discourse'

const argv = process.argv.slice(2)
const profileIndex = argv.indexOf('--profile')
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop'
const fix = argv.includes('--fix')

if (profileIndex >= 0 && (profile === undefined || profile.startsWith('--'))) {
  console.error('usage: node scripts/doctor.mjs [--profile <name>] [--fix]')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PACKAGE)

if (!existsSync(manifestPath)) {
  console.error(`no DSH profile at ${profileDir}: open DeepSeek Harness once for that profile, then retry`)
  process.exit(2)
}

/** Read JSON that a Windows editor or PowerShell may have prefixed with a BOM. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

/** The spec the profile records for this bundle, when it records one. */
function dependencySpec() {
  try {
    const manifest = readJson(manifestPath)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const spec = manifest?.[field]?.[PACKAGE]
      if (typeof spec === 'string' && spec.length > 0) return spec
    }
  } catch (error) {
    console.error(`could not read ${manifestPath}: ${error.message}`)
    process.exit(2)
  }
  return undefined
}

/**
 * Inspect one node_modules entry. A junction (or symlink) resolves to a
 * different path than the lexical entry; a normal package directory does not.
 */
function inspectEntry(path) {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return undefined
  }
  let target
  try {
    target = realpathSync.native(path)
  } catch {
    target = undefined
  }
  let expected = resolve(path)
  try {
    expected = join(realpathSync.native(dirname(path)), basename(path))
  } catch {
    // The parent is always readable when lstat succeeded; keep the lexical form.
  }
  const same = target !== undefined && (process.platform === 'win32'
    ? target.toLowerCase() === expected.toLowerCase()
    : target === expected)
  return { target, isLink: stats.isSymbolicLink() || !same }
}

/** Remove a link without ever recursing into its target. */
function removeLink(path) {
  try {
    unlinkSync(path)
    return
  } catch (error) {
    if (!['EPERM', 'EISDIR', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
  }
  // On Windows rmdir deletes the junction's reparse point, not the target.
  rmdirSync(path)
}

const entry = inspectEntry(linkPath)

if (entry === undefined) {
  console.log(`ok: no stale ${PACKAGE} entry in ${profileDir}; run "dsh plugin --profile ${profile} add ${PACKAGE}" to install it`)
  process.exit(0)
}

if (!entry.isLink) {
  if (existsSync(join(linkPath, 'package.json'))) {
    console.log(`ok: ${PACKAGE} is installed as a normal directory in ${profileDir}`)
    process.exit(0)
  }
  console.error(`${linkPath} exists but is not a package and not a link; inspect it by hand`)
  process.exit(1)
}

const spec = dependencySpec()
const target = entry.target ?? '(unresolvable)'
const localSpec = spec !== undefined && (spec.startsWith('link:') || spec.startsWith('file:'))

console.log(`found a directory link for ${PACKAGE}:`)
console.log(`  link:       ${linkPath}`)
console.log(`  target:     ${target}`)
console.log(`  dependency: ${spec ?? '(not recorded)'}`)
console.log(localSpec
  ? 'The profile records a local spec, so this link is expected while the checkout is installed directly.'
  : 'The profile records a registry spec, so this link is a leftover from an earlier local install.')

if (!fix) {
  if (localSpec) {
    console.log('ok: this is a local development install; rerun with --fix only when switching the profile to the npm package.')
    process.exit(0)
  }
  console.error('stale link blocks "pnpm install"; re-run with --fix to remove the link only, then install again:')
  console.error(`  node scripts/doctor.mjs --profile ${profile} --fix`)
  console.error(`  dsh plugin --profile ${profile} add ${PACKAGE}`)
  process.exit(1)
}

try {
  removeLink(linkPath)
} catch (error) {
  console.error(`could not remove ${linkPath}: ${error.message}`)
  console.error('close DeepSeek Harness, then retry, or delete the junction in Explorer.')
  process.exit(1)
}

if (existsSync(linkPath) || inspectEntry(linkPath) !== undefined) {
  console.error(`${linkPath} still exists after removal`)
  process.exit(1)
}

console.log(`removed the link; ${target === '(unresolvable)' ? 'the target' : target} was left untouched.`)
console.log('now install the bundle:')
console.log(`  dsh plugin --profile ${profile} add ${PACKAGE}`)
