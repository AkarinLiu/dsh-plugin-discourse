#!/usr/bin/env node
/**
 * Offline end-to-end test for the browser sign-in tool.
 *
 * A stub credential store, a stub authorization seam, and a stub forum exercise
 * the real `apply()` path: start the classic authorization page, complete it
 * with an encrypted payload, read the signed-in status, cancel a pending
 * attempt, and sign out; then repeat through the device-code path. The test
 * never reaches the network and never prints the user API key.
 */

import { constants, publicEncrypt } from 'node:crypto'
import { apply } from '../index.js'

// The plugin also reads these from the environment; keep the test deterministic.
delete process.env.DISCOURSE_API_KEY
delete process.env.DISCOURSE_API_USERNAME

const problems = []
const store = new Map()
const flows = new Map()
const requests = []
let activeController
let deviceSupported = false
let deviceAuth
let devicePolls = 0
const DEVICE_KEY = 'device-key-456'

/** Build a JSON response without a network. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const credentials = {
  async readRecord(key) {
    return store.get(key)
  },
  async describeRecord(key) {
    const record = store.get(key)
    return { configured: record !== undefined, kind: record?.kind, writable: true }
  },
  async modifyRecord(key, mutate) {
    const next = await mutate(store.get(key))
    if (next === undefined) return store.get(key)
    store.set(key, next)
    return next
  },
  async deleteRecord(key) {
    store.delete(key)
  },
}

const authorization = {
  registerFlow(flow) {
    flows.set(flow.key, flow)
    return () => {
      flows.delete(flow.key)
      this.cancel(flow.key)
    }
  },
  cancel() {
    activeController?.abort()
  },
  async begin({ key, signal, interaction }) {
    const flow = flows.get(key)
    if (flow === undefined) {
      const error = new Error(`no authorization flow for ${key}`)
      error.code = 'NO_FLOW'
      throw error
    }
    activeController = new AbortController()
    const combined = signal ?? activeController.signal
    const session = {
      method: flow.methods[0].id,
      signal: combined,
      notify: (notice) => interaction.notify(notice),
      prompt: (question) => interaction.prompt(question),
      commit: async (record) => {
        await credentials.modifyRecord(key, () => Promise.resolve(record))
      },
    }
    try {
      await flow.run(session)
      return { status: 'authorized' }
    } catch (error) {
      if (combined.aborted) return { status: 'cancelled' }
      throw error
    }
  },
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const headers = new Headers(init.headers)
  requests.push({ path: url.pathname, method: init.method ?? 'GET', headers })
  if (url.pathname === '/user-api-key/device.json') {
    if (!deviceSupported) {
      // Pretend this is a forum older than the device authorization flow.
      return json({ errors: ['not found'] }, 404)
    }
    const body = JSON.parse(init.body)
    deviceAuth = { publicKey: body.public_key, nonce: body.nonce }
    devicePolls = 0
    return json({
      device_code: 'a'.repeat(64),
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://forum.test/user-api-key/activate',
      verification_uri_with_request: 'https://forum.test/user-api-key/activate?request=abcd1234',
      expires_in: 600,
      interval: 1,
    })
  }
  if (url.pathname === '/user-api-key/device/poll.json') {
    if (!deviceSupported) return json({ errors: ['not found'] }, 404)
    devicePolls += 1
    if (devicePolls === 1) return json({ status: 'authorization_pending' })
    const plaintext = JSON.stringify({ key: DEVICE_KEY, nonce: deviceAuth.nonce, push: false, api: 4 })
    const payload = publicEncrypt(
      { key: deviceAuth.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(plaintext, 'utf8'),
    ).toString('base64')
    return json({ status: 'authorized', payload })
  }
  if (url.pathname === '/session/current.json') {
    const key = headers.get('user-api-key')
    if (key === 'user-key-123') return json({ current_user: { id: 7, username: 'tester' } })
    if (key === DEVICE_KEY) return json({ current_user: { id: 8, username: 'device-tester' } })
    return json({ errors: ['bad key'] }, 403)
  }
  if (url.pathname === '/user-api-key/revoke.json') {
    const key = headers.get('user-api-key')
    if (key === 'user-key-123' || key === DEVICE_KEY) return json({ success: 'OK' })
    return json({ errors: ['bad key'] }, 403)
  }
  return json({ errors: [`unexpected ${url.pathname}`] }, 500)
}

const registry = new Map()
const ctx = {
  tools: {
    register(tool) {
      registry.set(tool.name, tool)
      return () => registry.delete(tool.name)
    },
  },
  effect(callback) {
    const dispose = callback()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  get(name) {
    if (name === 'credentials') return credentials
    if (name === 'authorization') return authorization
    return undefined
  },
  inject(_deps, callback) {
    return callback(ctx)
  },
}

apply(ctx, {
  baseUrl: 'https://forum.test',
  apiKey: '',
  authMode: 'auto',
  loginScopes: 'read,write,session_info',
  loginTimeoutMs: 60000,
})

const login = registry.get('discourse_login')
if (login === undefined) problems.push('discourse_login was not registered')

if (problems.length === 0) {
  const started = await login.execute({ action: 'start' }, {})
  if (started.signedIn !== false) problems.push('start should report signed out')
  if (started.attempt?.status !== 'pending') problems.push(`start should report a pending attempt, got ${started.attempt?.status}`)
  if (started.attempt?.mode !== 'manual') problems.push(`classic fallback should use manual mode, got ${started.attempt?.mode}`)
  if (typeof started.attempt?.url !== 'string') problems.push('start did not return an authorization URL')

  const startView = login.output.render({ action: 'start' }, started).map((block) => block.text).join('\n')
  if (!startView.includes(started.attempt.url)) problems.push('start render did not include the authorization URL')
  if (!startView.includes('discourse_login')) problems.push('start render did not explain the next status call')

  const url = new URL(started.attempt.url)
  if (!url.pathname.endsWith('/user-api-key/new')) problems.push(`unexpected authorization path ${url.pathname}`)
  if (url.searchParams.get('client_id') !== 'dsh-plugin-discourse') problems.push('authorization URL lost the client id')
  if (url.searchParams.has('padding')) problems.push('classic fallback should let the forum use its default padding')
  const publicKey = url.searchParams.get('public_key')
  const nonce = url.searchParams.get('nonce')
  if (typeof publicKey !== 'string' || !publicKey.includes('BEGIN PUBLIC KEY')) problems.push('authorization URL has no PEM public key')
  if (typeof nonce !== 'string' || nonce.length < 32) problems.push('authorization URL has no nonce')

  const plaintext = JSON.stringify({ key: 'user-key-123', nonce, push: false, api: 4 })
  // The classic page omits `padding`, so Discourse encrypts with PKCS#1 there;
  // the device path uses OAEP. Both decryption branches are covered here.
  const payload = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64')

  const completed = await login.execute({ action: 'complete', payload }, {})
  if (completed.signedIn !== true) problems.push('complete should report signed in')
  if (completed.session?.username !== 'tester') problems.push(`complete should read the account, got ${JSON.stringify(completed.session)}`)
  if (completed.session?.scopes?.join(',') !== 'read,write,session_info') problems.push('session scopes did not round-trip')
  if (JSON.stringify(completed).includes('user-key-123')) problems.push('complete leaked the user API key')

  const status = await login.execute({ action: 'status' }, {})
  if (status.signedIn !== true) problems.push('status should report signed in after complete')
  if (status.activeSource !== 'user-session') problems.push(`status source should be user-session, got ${status.activeSource}`)
  if (JSON.stringify(status).includes('user-key-123')) problems.push('status leaked the user API key')

  const record = store.get('discourse/session')
  if (record?.kind !== 'grant') problems.push('the session record is not a grant')
  if (record?.payload?.baseUrl !== 'https://forum.test') problems.push('the session record has the wrong forum')
  if (record?.payload?.clientId !== 'dsh-plugin-discourse') problems.push('the session record has the wrong client id')

  const rendered = login.output.render({ action: 'status' }, status).map((block) => block.text).join('\n')
  if (!rendered.includes('@tester')) problems.push(`render did not name the account: ${rendered}`)
  if (rendered.includes('user-key-123')) problems.push('render leaked the user API key')

  const signedOut = await login.execute({ action: 'logout' }, {})
  if (signedOut.signedOut !== true) problems.push('logout should report signed out')
  if (signedOut.revoked !== true) problems.push('logout should revoke the forum key')
  if (store.size !== 0) problems.push('logout did not delete the local session record')

  const after = await login.execute({ action: 'status' }, {})
  if (after.signedIn !== false) problems.push('status should report signed out after logout')

  const revoke = requests.find((request) => request.path === '/user-api-key/revoke.json')
  if (revoke === undefined) problems.push('logout did not call the revoke endpoint')
  else if (revoke.headers.get('user-api-key') !== 'user-key-123') problems.push('logout did not authenticate with the user API key')

  const restarted = await login.execute({ action: 'start', mode: 'manual' }, {})
  if (restarted.attempt?.status !== 'pending') problems.push('manual restart should be pending before cancel')
  const cancelled = await login.execute({ action: 'cancel' }, {})
  if (cancelled.cancelled !== true) problems.push('cancel should report that an attempt was cancelled')
  if (cancelled.signedIn !== false) problems.push('cancel should leave the session signed out')
  if (cancelled.attempt !== undefined) problems.push('cancel should clear the pending attempt')
}

// The device flow is the preferred path on a current forum: request a code,
// poll while pending, then accept the encrypted payload.
if (problems.length === 0) {
  deviceSupported = true
  const started = await login.execute({ action: 'start', mode: 'device' }, {})
  if (started.signedIn !== false) problems.push('device start should report signed out')
  if (started.attempt?.status !== 'pending') problems.push(`device start should report pending, got ${started.attempt?.status}`)
  if (started.attempt?.mode !== 'device') problems.push(`device start should report device mode, got ${started.attempt?.mode}`)
  if (started.attempt?.userCode !== 'ABCD-EFGH') problems.push(`device start lost the user code: ${started.attempt?.userCode}`)
  if (!String(started.attempt?.url).includes('/user-api-key/activate')) problems.push('device start did not return the activation URL')

  const waited = await login.execute({ action: 'status', waitSeconds: 10 }, {})
  if (waited.signedIn !== true) problems.push('device status wait should report signed in')
  if (waited.session?.username !== 'device-tester') problems.push(`device sign-in should read the account, got ${JSON.stringify(waited.session)}`)
  if (JSON.stringify(waited).includes(DEVICE_KEY)) problems.push('device status leaked the user API key')
  if (devicePolls < 2) problems.push(`device flow should poll at least twice, polled ${devicePolls}`)

  const record = store.get('discourse/session')
  if (record?.payload?.source !== 'device') problems.push(`device session source should be device, got ${record?.payload?.source}`)

  const signedOut = await login.execute({ action: 'logout' }, {})
  if (signedOut.revoked !== true) problems.push('device logout should revoke the forum key')
  if (store.size !== 0) problems.push('device logout did not delete the local session record')
}

if (problems.length > 0) {
  console.error('browser login test failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('ok: browser login starts, completes, reports, and revokes offline')
