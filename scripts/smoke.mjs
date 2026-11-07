#!/usr/bin/env node
/**
 * Offline and live smoke test for the Discourse plugin.
 *
 * The stub context mirrors what the Loader provides to `apply`, so this
 * exercises the real registration path without booting a Harness.
 *
 *   node scripts/smoke.mjs          definition checks only
 *   node scripts/smoke.mjs --live   also call read-only tools against the forum
 */

import { apply } from '../index.js'

const live = process.argv.includes('--live')
const baseUrl = process.env.DISCOURSE_BASE_URL ?? 'https://meta.discourse.org'
const registry = new Map()
const problems = []

const ctx = {
  tools: {
    register(definition) {
      if (registry.has(definition.name)) problems.push(`duplicate tool name ${definition.name}`)
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  },
  effect(callback, label) {
    const dispose = callback()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

apply(ctx, { baseUrl, readOnly: true, maxItems: 5 })

const expected = [
  'discourse_search',
  'discourse_topics',
  'discourse_topic',
  'discourse_categories',
  'discourse_user',
  'discourse_create_topic',
  'discourse_reply',
  'discourse_update_post',
  'discourse_flag_post',
  'discourse_review_queue',
  'discourse_delete_post',
  'discourse_restore_post',
  'discourse_admin_users',
  'discourse_moderate_user',
  'discourse_site_settings',
  'discourse_admin_stats',
]

for (const name of expected) {
  if (!registry.has(name)) problems.push(`missing tool ${name}`)
}
for (const name of registry.keys()) {
  if (!expected.includes(name)) problems.push(`unexpected tool ${name}`)
}

for (const [name, tool] of registry) {
  if (!/^discourse_[a-z_]+$/.test(name)) problems.push(`${name}: name must match discourse_[a-z_]+`)
  if (typeof tool.description !== 'string' || tool.description.length < 40) problems.push(`${name}: description too short`)
  if (tool.parameters?.type !== 'object') problems.push(`${name}: parameters must be an object schema`)
  if (tool.parameters?.additionalProperties !== false) problems.push(`${name}: parameters must set additionalProperties false`)
  if (typeof tool.output?.render !== 'function') problems.push(`${name}: output.render missing`)
  if (tool.output?.schema?.type !== 'object') problems.push(`${name}: output schema must be an object`)
  if (typeof tool.execute !== 'function') problems.push(`${name}: execute missing`)
  for (const [key, schema] of Object.entries(tool.parameters?.properties ?? {})) {
    if (typeof schema.description !== 'string' || schema.description.length === 0) problems.push(`${name}.${key}: parameter needs a description`)
    if (schema.type === undefined && schema.oneOf === undefined) problems.push(`${name}.${key}: parameter needs a type`)
  }
}

// A malformed forum URL must fail at activation with a usable diagnostic,
// before any tool is registered.
try {
  apply({
    tools: { register() { problems.push('invalid baseUrl registered a tool') } },
    effect(callback) { callback() },
  }, { baseUrl: 'ftp://forum.example.com' })
  problems.push('invalid baseUrl was accepted')
} catch (error) {
  if (!/http\(s\) URL/.test(error.message)) problems.push(`invalid baseUrl diagnostic is unhelpful: ${error.message}`)
}

const describe = (value) => {
  const rendered = value.map((block) => block.text ?? `[${block.type}]`).join('\n')
  return rendered.length > 700 ? `${rendered.slice(0, 700)}…` : rendered
}

if (live) {
  const cases = [
    ['discourse_categories', {}],
    ['discourse_topics', { filter: 'latest', limit: 3 }],
    ['discourse_search', { q: 'api', limit: 3 }],
    ['discourse_topic', { topic: 1, limit: 2 }],
    ['discourse_user', { username: 'system' }],
  ]
  for (const [name, args] of cases) {
    try {
      const value = await registry.get(name).execute(args, { signal: AbortSignal.timeout(30000) })
      console.log(`\n=== ${name} ===\n${describe(registry.get(name).output.render(args, value))}`)
    } catch (error) {
      problems.push(`${name}: ${error.message}`)
    }
  }
}

if (problems.length > 0) {
  console.error('smoke test failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`ok: ${registry.size} tools registered${live ? ' (live calls included)' : ''}`)
