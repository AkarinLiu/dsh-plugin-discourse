/**
 * Discourse administration and agent tools for the DeepSeek Harness.
 *
 * One Host plugin registers model-facing tools over the Discourse REST API:
 * reading topics and users, authoring posts, running moderator/administrator
 * operations, and signing in through the browser with a scoped user API key.
 * Every request carries either the stored user session or the configured API
 * key, and `readOnly` turns the plugin into an inspection-only surface.
 *
 * @module dsh-plugin-discourse
 */

import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto'

/** Loader row id used by this bundle. */
export const name = 'discourse'

/** The plugin needs the tool registry before `apply` runs. */
export const inject = ['tools']

/** Forum used when the deployment config names none. */
const DEFAULT_BASE_URL = 'https://meta.discourse.org'
/** Request deadline when the deployment config names none. */
const DEFAULT_TIMEOUT_MS = 20000
/** Default number of items in one listing. */
const DEFAULT_LIMIT = 12
/** Hard cap on items in one listing. */
const MAX_LIMIT = 50
/** Characters kept from one post body or search blurb. */
const MAX_BODY = 700
/** Hours a resolved category list stays trustworthy. */
const CATEGORY_TTL_MS = 5 * 60 * 1000
/** Credential record holding the browser-authorized user session. */
const SESSION_KEY = 'discourse/session'
/** Scopes requested by the browser sign-in when the config names none. */
const DEFAULT_LOGIN_SCOPES = 'read,write,session_info'
/** Application name shown on the forum authorization page. */
const DEFAULT_LOGIN_APPLICATION = 'DeepSeek Harness'
/** Client id Discourse stores with the authorized user API key. */
const DEFAULT_LOGIN_CLIENT_ID = 'dsh-plugin-discourse'
/** Browser sign-in deadline when the config names none (Discourse's device code lives 10 minutes). */
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Per-tool output schema: an open object, because each tool projects its own shape. */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/**
 * Raise one operator-facing failure.
 * @param {string} message - what the operator must fix or retry.
 * @returns {never} always throws.
 */
function fail(message) {
  throw new Error(message)
}

/** Named HTML entities Discourse emits inside excerpts and post bodies. */
const NAMED_ENTITIES = {
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
}

/**
 * Trim one value to a bounded string.
 * @param {unknown} value - any model or API value.
 * @param {number} max - maximum characters to keep.
 * @returns {string} the clipped single-line-or-multiline string.
 */
function clip(value, max = MAX_BODY) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * Read a required string argument.
 * @param {unknown} value - candidate argument.
 * @param {string} label - argument name for the diagnostic.
 * @returns {string} the trimmed value.
 */
function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`invalid arguments: \`${label}\` must be a non-empty string`)
  return value.trim()
}

/**
 * Read an optional string argument.
 * @param {unknown} value - candidate argument.
 * @returns {string | undefined} the trimmed value, or undefined when absent.
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Read an integer argument, applying a default and a cap.
 * @param {unknown} value - candidate argument.
 * @param {number} fallback - value used when the argument is absent.
 * @param {number} max - upper bound after defaults.
 * @param {number} min - lower bound after defaults.
 * @returns {number} the bounded integer.
 */
function integer(value, fallback, max, min = 1) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('invalid arguments: expected an integer')
  return Math.min(max, Math.max(min, value))
}

/**
 * Read a required integer argument.
 * @param {unknown} value - candidate argument.
 * @param {string} label - argument name for the diagnostic.
 * @returns {number} the integer.
 */
function requiredInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`invalid arguments: \`${label}\` must be a positive integer`)
  return value
}

/**
 * Convert the rendered HTML Discourse returns into readable text.
 * @param {unknown} html - cooked post HTML.
 * @returns {string} plain text with paragraph breaks preserved.
 */
function toPlainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo|middot|bull|copy|reg|trade);/g, (_match, name) => NAMED_ENTITIES[name] ?? _match)
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Format one ISO timestamp as a calendar date.
 * @param {unknown} value - ISO timestamp from the API.
 * @returns {string} a `YYYY-MM-DD` prefix, or an empty string.
 */
function day(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length >= 10 ? text.slice(0, 10) : text
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Normalize the loader row config into one resolved client configuration.
 *
 * The API key may come from the row config or from `DISCOURSE_API_KEY`, so a
 * shared profile file never needs to carry the secret itself. Browser sign-in
 * settings default to a scoped user API key that can read, write, and read the
 * current session; a deployment may narrow the scopes.
 *
 * @param {unknown} raw - the loader row config object.
 * @returns {{ baseUrl: string, apiKey: string, apiUsername: string, readOnly: boolean, timeoutMs: number, maxItems: number, authMode: 'auto' | 'api-key' | 'user', loginScopes: string[], loginClientId: string, loginApplicationName: string, loginTimeoutMs: number }} the resolved configuration.
 */
function readConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const declared = optionalString(source.baseUrl) ?? DEFAULT_BASE_URL
  let parsed
  try {
    parsed = new URL(declared)
  } catch {
    fail(`invalid config: \`baseUrl\` must be an http(s) URL, got ${JSON.stringify(declared)}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`invalid config: \`baseUrl\` must be an http(s) URL, got ${JSON.stringify(declared)}`)
  }
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  const envKey = typeof process !== 'undefined' ? process.env?.DISCOURSE_API_KEY : undefined
  const envUser = typeof process !== 'undefined' ? process.env?.DISCOURSE_API_USERNAME : undefined
  const apiKey = optionalString(source.apiKey) ?? optionalString(envKey) ?? ''
  const apiUsername = optionalString(source.apiUsername) ?? optionalString(envUser) ?? 'system'
  const timeoutMs = typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs)
    ? Math.min(120000, Math.max(1000, Math.round(source.timeoutMs)))
    : DEFAULT_TIMEOUT_MS
  const maxItems = typeof source.maxItems === 'number' && Number.isFinite(source.maxItems)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.round(source.maxItems)))
    : DEFAULT_LIMIT
  const authMode = typeof source.authMode === 'string' ? source.authMode.trim().toLowerCase() : 'auto'
  if (authMode !== 'auto' && authMode !== 'api-key' && authMode !== 'user') {
    fail(`invalid config: \`authMode\` must be "auto", "api-key", or "user", got ${JSON.stringify(source.authMode)}`)
  }
  const loginScopes = readLoginScopes(source.loginScopes)
  const loginClientId = optionalString(source.loginClientId) ?? DEFAULT_LOGIN_CLIENT_ID
  const loginApplicationName = optionalString(source.loginApplicationName) ?? DEFAULT_LOGIN_APPLICATION
  for (const [label, value] of [['loginClientId', loginClientId], ['loginApplicationName', loginApplicationName]]) {
    if (Buffer.byteLength(value, 'utf8') > 200) fail(`invalid config: \`${label}\` must be at most 200 bytes`)
  }
  const loginTimeoutMs = typeof source.loginTimeoutMs === 'number' && Number.isFinite(source.loginTimeoutMs)
    ? Math.min(1800000, Math.max(30000, Math.round(source.loginTimeoutMs)))
    : DEFAULT_LOGIN_TIMEOUT_MS
  return {
    baseUrl,
    apiKey,
    apiUsername,
    readOnly: source.readOnly === true,
    timeoutMs,
    maxItems,
    authMode,
    loginScopes,
    loginClientId,
    loginApplicationName,
    loginTimeoutMs,
  }
}

/**
 * Normalize the scopes requested by browser sign-in.
 * @param {unknown} value - a comma-separated string or an array of scope names.
 * @returns {string[]} unique lowercase scope names.
 */
function readLoginScopes(value) {
  const entries = Array.isArray(value) ? value : String(value ?? DEFAULT_LOGIN_SCOPES).split(',')
  const scopes = []
  for (const entry of entries) {
    const scope = String(entry ?? '').trim().toLowerCase()
    if (scope.length === 0) continue
    if (!/^[a-z][a-z0-9_]*$/.test(scope)) fail(`invalid config: \`loginScopes\` contains an invalid scope ${JSON.stringify(entry)}`)
    if (!scopes.includes(scope)) scopes.push(scope)
  }
  if (scopes.length === 0) fail('invalid config: `loginScopes` must name at least one scope')
  if (scopes.length > 20) fail('invalid config: `loginScopes` names more than 20 scopes')
  return scopes
}

// ---------------------------------------------------------------------------
// Stored browser session
// ---------------------------------------------------------------------------

/**
 * Validate one stored credential record and project it into a session.
 *
 * The record is owned by this plugin and addressed as `discourse/session`.
 * A record for another forum, an unsupported version, or one without a key is
 * reported as an error rather than used, so a changed `baseUrl` never sends the
 * wrong forum's credential to a new host.
 *
 * @param {unknown} record - `credentials.readRecord()` result.
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @returns {{ session?: Record<string, any>, error?: string }} the validated session or a diagnostic.
 */
function readSessionRecord(record, config) {
  if (record === undefined || record === null) return {}
  if (record.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') {
    return { error: 'the stored Discourse sign-in is not a grant record' }
  }
  const payload = record.payload
  if (payload.version !== 1) return { error: `the stored Discourse sign-in uses unsupported version ${JSON.stringify(payload.version)}` }
  if (payload.baseUrl !== config.baseUrl) return { error: `the stored Discourse sign-in belongs to ${JSON.stringify(payload.baseUrl)}` }
  if (typeof payload.key !== 'string' || payload.key.length === 0) return { error: 'the stored Discourse sign-in has no user API key' }
  const expiresAt = typeof payload.expiresAt === 'string' && payload.expiresAt.length > 0 ? payload.expiresAt : null
  const expiresAtMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt)
  if (expiresAt !== null && !Number.isFinite(expiresAtMs)) {
    return { error: `the stored Discourse sign-in has an invalid expiry ${JSON.stringify(expiresAt)}` }
  }
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()
  return {
    session: {
      key: payload.key,
      username: typeof payload.username === 'string' && payload.username.length > 0 ? payload.username : null,
      clientId: typeof payload.clientId === 'string' && payload.clientId.length > 0 ? payload.clientId : config.loginClientId,
      scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((scope) => typeof scope === 'string') : [],
      apiVersion: typeof payload.apiVersion === 'number' ? payload.apiVersion : null,
      source: typeof payload.source === 'string' ? payload.source : null,
      createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
      expiresAt,
      expired,
    },
  }
}

/**
 * Read and validate the stored browser session.
 * @param {any} credentials - the credential service, when the profile provides one.
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @returns {Promise<{ storageAvailable: boolean, session?: Record<string, any>, error?: string }>} the read result.
 */
async function readStoredSession(credentials, config) {
  if (credentials === undefined || credentials === null) return { storageAvailable: false }
  let record
  try {
    record = await credentials.readRecord(SESSION_KEY)
  } catch (error) {
    return { storageAvailable: true, error: `could not read the stored Discourse sign-in: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { storageAvailable: true, ...readSessionRecord(record, config) }
}

/**
 * Project a session onto the fields a tool may show.
 * @param {Record<string, any>} session - validated session.
 * @returns {Record<string, unknown>} the public session view, without the key.
 */
function publicSession(session) {
  return {
    username: session.username,
    clientId: session.clientId,
    scopes: session.scopes,
    apiVersion: session.apiVersion,
    source: session.source,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    expired: session.expired === true,
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * Build the request client shared by every tool of one activation.
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @param {() => any} [getCredentials] - resolves the credential service on demand.
 * @returns {{ call: Function, writable: Function, categories: Function, resolveCategory: Function, config: object }} the client.
 */
function createClient(config, getCredentials = () => undefined) {
  const cache = { at: 0, entries: [] }

  /**
   * Read the stored browser session for request authentication.
   * @returns {Promise<Record<string, any> | undefined>} a non-expired session for this forum.
   */
  async function readSession() {
    const credentials = getCredentials()
    if (credentials === undefined || credentials === null) return undefined
    try {
      const record = await credentials.readRecord(SESSION_KEY)
      const projected = readSessionRecord(record, config)
      if (projected.session !== undefined && projected.session.expired !== true) return projected.session
    } catch {
      // A storage failure falls back to the configured API key or anonymous reads.
    }
    return undefined
  }

  /**
   * Compose request authorization for one operation.
   * @param {{ anonymous?: boolean, privileged?: boolean, userApiKey?: string }} options - caller intent.
   * @returns {Promise<Record<string, string>>} the authorization headers.
   */
  async function authHeaders(options) {
    if (typeof options.userApiKey === 'string' && options.userApiKey.length > 0) {
      return { 'User-Api-Key': options.userApiKey }
    }
    if (options.anonymous === true) return {}
    const apiHeaders = config.apiKey.length > 0
      ? { 'Api-Key': config.apiKey, 'Api-Username': config.apiUsername }
      : {}
    if (config.authMode === 'api-key') return apiHeaders
    const session = await readSession()
    if (config.authMode === 'user') {
      if (session === undefined) {
        fail('Discourse browser sign-in is required by `authMode: user`, but no valid session is stored. Run discourse_login with action "start".')
      }
      return {
        'User-Api-Key': session.key,
        ...(session.clientId.length > 0 ? { 'User-Api-Client-Id': session.clientId } : {}),
      }
    }
    if (options.privileged === true && config.apiKey.length > 0) return apiHeaders
    if (session !== undefined) {
      return {
        'User-Api-Key': session.key,
        ...(session.clientId.length > 0 ? { 'User-Api-Client-Id': session.clientId } : {}),
      }
    }
    return apiHeaders
  }

  /**
   * Issue one Discourse request and decode its JSON body.
   * @param {string} method - HTTP method.
   * @param {string} path - absolute path such as `/latest.json`.
   * @param {{ query?: Record<string, unknown>, body?: unknown, signal?: AbortSignal, anonymous?: boolean, privileged?: boolean, userApiKey?: string }} [options] - query values, JSON body, caller cancellation, and authentication intent.
   * @returns {Promise<any>} the decoded body, or text for non-JSON responses.
   */
  async function call(method, path, options = {}) {
    const query = options.query ?? {}
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      search.set(key, String(value))
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    const url = `${config.baseUrl}${path}${suffix}`

    const headers = { Accept: 'application/json', ...(await authHeaders(options)) }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    const deadline = AbortSignal.timeout(config.timeoutMs)
    const signal = options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, deadline])
      : deadline

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        redirect: 'follow',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted) fail(`Discourse request cancelled: ${method} ${path}`)
      fail(`Discourse request failed: ${method} ${path} (${reason})`)
    }

    const usedSession = headers['User-Api-Key'] !== undefined
    const text = await response.text()
    let payload
    try {
      payload = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      payload = text
    }

    if (!response.ok) {
      const detail = describeError(payload)
      const hint = response.status === 401 && usedSession
        ? ' The stored Discourse session was rejected; run discourse_login with action "start" to sign in again.'
        : response.status === 403
          ? options.anonymous === true
            ? ' The forum rejected anonymous user API key authorization; check that user API keys are enabled and the requested scopes are allowed.'
            : usedSession
              ? ' The signed-in user API key may lack the scope this endpoint needs; staff and admin endpoints require the configured apiKey.'
              : ' The API key needs an admin-scoped key for this endpoint.'
          : response.status === 404
            ? ' Check that the forum URL and the target id are correct.'
            : ''
      fail(`Discourse ${method} ${path} failed (HTTP ${response.status}): ${detail}${hint}`)
    }
    return payload
  }

  /**
   * Extract the most useful message from a Discourse error body.
   * @param {unknown} payload - decoded error body.
   * @returns {string} a bounded diagnostic.
   */
  function describeError(payload) {
    if (payload !== null && typeof payload === 'object') {
      const errors = payload.errors
      if (Array.isArray(errors) && errors.length > 0) return clip(errors.join('; '), 400)
      if (typeof payload.error_type === 'string' && payload.error_type.length > 0) return `${payload.error_type}: ${clip(payload.error, 300)}`
      if (typeof payload.error === 'string') return clip(payload.error, 400)
    }
    return clip(payload, 400) || 'no response body'
  }

  /**
   * Refuse a mutating operation when the deployment is inspection-only.
   * @param {string} operation - the human-facing operation name.
   * @returns {void}
   */
  function writable(operation) {
    if (config.readOnly) fail(`readOnly is enabled for this Discourse plugin, so ${operation} is unavailable. Disable readOnly in the plugin config to allow writes.`)
  }

  /**
   * Load the forum category directory, reusing a short-lived cache.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Array<Record<string, any>>>} flattened categories including subcategories.
   */
  async function categories(signal) {
    if (cache.entries.length > 0 && Date.now() - cache.at < CATEGORY_TTL_MS) return cache.entries
    const payload = await call('GET', '/categories.json', { query: { include_subcategories: 'true' }, signal })
    const roots = payload?.category_list?.categories ?? payload?.categories ?? []
    const entries = []
    for (const root of Array.isArray(roots) ? roots : []) {
      entries.push(root)
      const children = root?.subcategory_list ?? root?.subcategories ?? []
      for (const child of Array.isArray(children) ? children : []) entries.push(child)
    }
    cache.entries = entries
    cache.at = Date.now()
    return entries
  }

  /**
   * Resolve a category id or slug to the pair used by the category listing route.
   * @param {unknown} input - a numeric id or a slug/name.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ id: number, slug: string }>} the resolved category.
   */
  async function resolveCategory(input, signal) {
    const raw = requiredString(input, 'category')
    if (/^\d+$/.test(raw)) return { id: Number(raw), slug: 'category' }
    const entries = await categories(signal)
    const needle = raw.replace(/^\/+|\/+$/g, '').toLowerCase()
    const found = entries.find((entry) => String(entry?.slug ?? '').toLowerCase() === needle)
      ?? entries.find((entry) => String(entry?.name ?? '').toLowerCase() === needle)
    if (found === undefined) {
      const known = entries.slice(0, 25).map((entry) => entry?.slug).filter(Boolean).join(', ')
      fail(`unknown category "${raw}"; known slugs include: ${known || '(none)'}`)
    }
    return { id: Number(found.id), slug: String(found.slug) }
  }

  return { call, writable, categories, resolveCategory, config }
}

// ---------------------------------------------------------------------------
// Browser authorization login
// ---------------------------------------------------------------------------

/**
 * Locate one service without requiring it at activation.
 * @param {any} context - a Cordis context or the smoke test's stub.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined when the profile does not provide it.
 */
function getService(context, name) {
  if (context === undefined || context === null) return undefined
  if (typeof context.get === 'function') {
    try {
      return context.get(name)
    } catch {
      return undefined
    }
  }
  return context[name]
}

/**
 * Resolve after a delay, rejecting when the caller's signal is withdrawn.
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal} [signal] - attempt cancellation.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('the Discourse sign-in attempt was cancelled'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('the Discourse sign-in attempt was cancelled'))
    }
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Race one promise against a deadline without leaving a live timer behind.
 * @param {Promise<any>} promise - the operation to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<any>} the operation's value.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for Discourse')), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Race one promise against a deadline, resolving undefined on timeout and
 * clearing the deadline timer when the operation settles first.
 * @param {Promise<any>} promise - the operation to bound.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<any>} the operation's value, or undefined on timeout.
 */
function raceTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Whether a device-authorization request failed because the forum predates it.
 * @param {unknown} error - request failure.
 * @returns {boolean} true when the classic flow should be attempted.
 */
function isMissingDeviceRoute(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP (?:404|405|501)\b/.test(message)
}

/**
 * Extract a Discourse encrypted payload from a pasted value.
 *
 * The classic authorization page shows the payload as text; a redirect URL
 * carries it as `?payload=…`, and a copied JSON response carries the same
 * field. All three shapes are accepted, including a whole page whose longest
 * Base64 run is the payload.
 *
 * @param {unknown} input - payload text, JSON, or URL supplied by the user.
 * @returns {string} the Base64 ciphertext.
 */
function extractEncryptedPayload(input) {
  let text = requiredString(input, 'payload')
  if (/^[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.payload === 'string') text = parsed.payload
    } catch {
      // Not JSON; keep looking for a URL or Base64 text.
    }
  }
  const queryMatch = /[?&]payload=([^&\s]+)/.exec(text)
  if (queryMatch !== null) {
    try {
      text = decodeURIComponent(queryMatch[1])
    } catch {
      text = queryMatch[1]
    }
  }
  const compact = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (compact.length >= 60 && /^[A-Za-z0-9+/=]+$/.test(compact)) return compact
  const candidates = text.match(/[A-Za-z0-9+/=_-]{60,}/g) ?? []
  if (candidates.length === 0) {
    fail('invalid payload: paste the encrypted payload that Discourse shows after you approve, or the full redirect URL')
  }
  const longest = candidates.reduce((best, candidate) => (candidate.length > best.length ? candidate : best), '')
  return longest.replace(/-/g, '+').replace(/_/g, '/')
}

/**
 * Decrypt one Discourse user API key payload with the attempt's private key.
 * @param {string} privateKey - PEM-encoded private key generated for the attempt.
 * @param {string} payload - Base64 ciphertext from the poll or the clipboard.
 * @returns {Record<string, any>} the decrypted payload with `key` and `nonce`.
 */
function decryptLoginPayload(privateKey, payload) {
  const normalized = String(payload ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (normalized.length === 0) fail('invalid payload: the encrypted payload is empty')
  const ciphertext = Buffer.from(normalized, 'base64')
  let lastError
  for (const options of [
    { padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    { padding: cryptoConstants.RSA_PKCS1_PADDING },
  ]) {
    try {
      const plaintext = privateDecrypt({ key: privateKey, ...options }, ciphertext).toString('utf8')
      const parsed = JSON.parse(plaintext)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.key === 'string' && parsed.key.length > 0) return parsed
      lastError = new Error('the decrypted payload carries no user API key')
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  fail(`could not decrypt the Discourse authorization payload (${reason}); start the sign-in again`)
}

/**
 * Build the classic user API key authorization URL.
 *
 * The classic page predates the device flow, so it is also the compatibility
 * path for older forums. It deliberately omits `padding`: those forums may not
 * know the parameter and use PKCS#1, while `decryptLoginPayload` accepts either
 * padding mode. The device flow, which targets current forums, always uses OAEP.
 *
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @param {{ publicKey: string, nonce: string, scopes: string[] }} plan - attempt key material and scopes.
 * @returns {string} the authorization page URL.
 */
function buildManualLoginUrl(config, plan) {
  const query = new URLSearchParams({
    application_name: config.loginApplicationName,
    client_id: config.loginClientId,
    nonce: plan.nonce,
    scopes: plan.scopes.join(','),
    public_key: plan.publicKey,
  })
  return `${config.baseUrl}/user-api-key/new?${query.toString()}`
}

/**
 * Build the browser sign-in controller for one plugin activation.
 *
 * The controller owns the current attempt, the interaction a tool call sees,
 * and the credential record read by the HTTP client. Discourse's device flow
 * (Auth API v4) is preferred; a forum without it falls back to the classic
 * page whose encrypted payload the user pastes back.
 *
 * @param {any} ctx - plugin context.
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @param {ReturnType<typeof createClient>} client - request client.
 * @returns {{ attach: Function, start: Function, status: Function, complete: Function, cancel: Function, logout: Function, waitFor: Function, dispose: Function }} the controller.
 */
function createLogin(ctx, config, client) {
  /** Credential and authorization services, once their provider is mounted. */
  let services
  /** The attempt started by this plugin, including its interaction surface. */
  let attempt
  /** Key material and mode for the attempt currently running through the authorization seam. */
  let activePlan
  let disposed = false
  let attachError

  const host = (() => {
    try {
      return new URL(config.baseUrl).host
    } catch {
      return config.baseUrl
    }
  })()
  const flowLabel = `Discourse (${host})`

  /**
   * Offer the sign-in flow to the authorization service.
   * @param {any} scope - context carrying `credentials` and `authorization`.
   * @returns {boolean} whether the flow is registered.
   */
  function attach(scope) {
    if (disposed) return false
    if (services !== undefined) return true
    const credentials = getService(scope, 'credentials')
    const authorization = getService(scope, 'authorization')
    if (credentials === undefined || authorization === undefined) return false
    const flow = {
      key: SESSION_KEY,
      label: flowLabel,
      methods: [{ id: 'browser', label: 'Sign in with browser' }],
      run: (session) => run(session),
    }
    let disposeFlow
    try {
      disposeFlow = authorization.registerFlow(flow)
    } catch (error) {
      attachError = error instanceof Error ? error.message : String(error)
      return false
    }
    const attached = { credentials, authorization }
    services = attached
    const effectHost = typeof scope.effect === 'function' ? scope : ctx
    if (typeof effectHost?.effect === 'function') {
      effectHost.effect(() => () => {
        disposeFlow()
        if (services === attached) services = undefined
      }, 'discourse:authorization flow')
    }
    return true
  }

  /**
   * Fail unless the credential store and authorization seam are available.
   * @returns {{ credentials: any, authorization: any }} the services.
   */
  function requireServices() {
    if (disposed) fail('the Discourse plugin is shutting down')
    if (services !== undefined) return services
    if (!attach(ctx)) {
      fail(attachError !== undefined
        ? `Discourse browser sign-in is unavailable: ${attachError}`
        : 'Discourse browser sign-in needs the DSH credential store and authorization service. This profile does not provide them.')
    }
    return services
  }

  /**
   * Generate the per-attempt RSA key pair and nonce.
   * @param {string[]} scopes - scopes to request.
   * @param {'auto' | 'device' | 'manual'} mode - transport preference.
   * @returns {{ publicKey: string, privateKey: string, nonce: string, scopes: string[], mode: string }} the attempt plan.
   */
  function createPlan(scopes, mode) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    return {
      publicKey,
      privateKey,
      nonce: randomBytes(32).toString('hex'),
      scopes: [...scopes],
      mode,
    }
  }

  /**
   * Read the approving account's username without making sign-in depend on it.
   * @param {string} key - freshly issued user API key.
   * @param {AbortSignal} signal - attempt cancellation.
   * @returns {Promise<Record<string, any> | undefined>} the account, or undefined when the scope cannot read it.
   */
  async function readLoginProfile(key, signal) {
    try {
      const payload = await client.call('GET', '/session/current.json', { userApiKey: key, signal })
      const current = payload?.current_user ?? payload?.user
      return current !== null && typeof current === 'object' ? current : undefined
    } catch (error) {
      // A 401 means the freshly issued key is unusable; do not store it. A
      // missing `session_info` scope (403) only costs the friendly username.
      if (/HTTP 401\b/.test(error instanceof Error ? error.message : String(error))) throw error
      return undefined
    }
  }

  /**
   * Validate and commit one decrypted payload through the authorization seam.
   * @param {any} session - authorization session.
   * @param {{ nonce: string, scopes: string[] }} plan - attempt plan.
   * @param {Record<string, any>} data - decrypted payload.
   * @param {'device' | 'manual'} source - which browser path produced it.
   * @returns {Promise<void>} resolves after the credential record is stored.
   */
  async function commitSession(session, plan, data, source) {
    if (typeof data.nonce !== 'string' || data.nonce !== plan.nonce) {
      fail('the Discourse authorization payload nonce did not match this attempt; start the sign-in again')
    }
    if (typeof data.key !== 'string' || data.key.length === 0) {
      fail('the Discourse authorization payload carried no user API key')
    }
    const profile = await readLoginProfile(data.key, session.signal)
    await session.commit({
      kind: 'grant',
      payload: {
        version: 1,
        baseUrl: config.baseUrl,
        key: data.key,
        username: typeof profile?.username === 'string' && profile.username.length > 0 ? profile.username : null,
        clientId: config.loginClientId,
        scopes: [...plan.scopes],
        apiVersion: typeof data.api === 'number' ? data.api : null,
        createdAt: new Date().toISOString(),
        expiresAt: typeof data.expires_at === 'string' && data.expires_at.length > 0 ? data.expires_at : null,
        source,
      },
    })
  }

  /**
   * Run Discourse's device authorization flow: request a code, notify the
   * browser destination, poll, decrypt, and commit.
   * @param {any} session - authorization session.
   * @param {any} plan - attempt plan.
   * @returns {Promise<void>} resolves after sign-in.
   */
  async function runDevice(session, plan) {
    let request
    try {
      request = await client.call('POST', '/user-api-key/device.json', {
        body: {
          nonce: plan.nonce,
          scopes: plan.scopes.join(','),
          client_id: config.loginClientId,
          application_name: config.loginApplicationName,
          public_key: plan.publicKey,
          padding: 'oaep',
        },
        anonymous: true,
        signal: session.signal,
      })
    } catch (error) {
      if (plan.mode === 'auto' && isMissingDeviceRoute(error)) return runManual(session, plan)
      throw error
    }
    if (typeof request?.device_code !== 'string' || request.device_code.length === 0) {
      if (plan.mode === 'auto') return runManual(session, plan)
      fail('Discourse did not return a device authorization code')
    }
    const deviceCode = request.device_code
    const rawUrl = optionalString(request.verification_uri_with_request) ?? optionalString(request.verification_uri)
    if (rawUrl === undefined) fail('Discourse did not return a verification URL for the device authorization code')
    let verificationUrl
    try {
      verificationUrl = new URL(rawUrl, config.baseUrl).href
    } catch {
      fail(`Discourse returned an invalid verification URL: ${JSON.stringify(rawUrl)}`)
    }
    const userCode = optionalString(request.user_code)
    const expiresIn = typeof request.expires_in === 'number' && Number.isFinite(request.expires_in) && request.expires_in > 0
      ? request.expires_in
      : 600
    const interval = Math.max(1, Math.min(30, typeof request.interval === 'number' && Number.isFinite(request.interval) ? request.interval : 5))
    const deadline = Math.min(Date.now() + config.loginTimeoutMs, Date.now() + expiresIn * 1000)
    session.notify({
      message: userCode === undefined
        ? `Open ${verificationUrl} and approve the sign-in for ${host}.`
        : `Open ${verificationUrl} and confirm the code ${userCode} to sign in to ${host}.`,
      url: verificationUrl,
      ...(userCode === undefined ? {} : { code: userCode }),
    })
    let failures = 0
    for (;;) {
      if (Date.now() >= deadline) fail('the Discourse device authorization code expired before it was approved; start the sign-in again')
      await sleep(interval * 1000, session.signal)
      let result
      try {
        result = await client.call('POST', '/user-api-key/device/poll.json', {
          body: { device_code: deviceCode },
          anonymous: true,
          signal: session.signal,
        })
        failures = 0
      } catch (error) {
        if (session.signal.aborted === true) throw error
        if (/HTTP 429\b/.test(error instanceof Error ? error.message : String(error))) {
          await sleep(interval * 2000, session.signal)
          continue
        }
        failures += 1
        if (failures >= 3) throw error
        continue
      }
      const status = result?.status
      if (status === 'authorization_pending') continue
      if (status === 'authorized') {
        if (typeof result?.payload !== 'string' || result.payload.length === 0) {
          fail('Discourse authorized the sign-in but returned no encrypted payload')
        }
        const data = decryptLoginPayload(plan.privateKey, result.payload)
        await commitSession(session, plan, data, 'device')
        return
      }
      if (status === 'access_denied') fail('the Discourse authorization request was denied in the browser')
      if (status === 'expired_token') fail('the Discourse device authorization code expired; start the sign-in again')
      fail(`Discourse returned an unexpected device authorization status ${JSON.stringify(status)}`)
    }
  }

  /**
   * Run the classic user API key page and finish from the pasted payload.
   * @param {any} session - authorization session.
   * @param {any} plan - attempt plan.
   * @returns {Promise<void>} resolves after sign-in.
   */
  async function runManual(session, plan) {
    const url = buildManualLoginUrl(config, plan)
    session.notify({
      message: `Open ${url}, approve the request, then copy the encrypted payload that Discourse shows and paste it back here.`,
      url,
    })
    const pasted = await session.prompt({
      kind: 'text',
      message: 'Paste the encrypted payload that Discourse showed after you approved the request.',
    })
    const payload = extractEncryptedPayload(pasted)
    const data = decryptLoginPayload(plan.privateKey, payload)
    await commitSession(session, plan, data, 'manual')
  }

  /**
   * Run one authorization attempt for whichever surface started it.
   * @param {any} session - authorization session supplied by the seam.
   * @returns {Promise<void>} resolves after the credential record is committed.
   */
  async function run(session) {
    if (disposed) fail('the Discourse plugin is shutting down')
    const plan = activePlan ?? createPlan(config.loginScopes, 'auto')
    if (activePlan === undefined) activePlan = plan
    try {
      if (plan.mode === 'manual') return await runManual(session, plan)
      return await runDevice(session, plan)
    } finally {
      if (activePlan === plan) activePlan = undefined
    }
  }

  /**
   * Project the active attempt onto safe status fields.
   * @returns {Record<string, unknown> | undefined} the attempt view.
   */
  function publicAttempt() {
    if (attempt === undefined) return undefined
    const view = {
      status: attempt.state,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
    }
    if (attempt.mode !== undefined) view.mode = attempt.mode
    if (attempt.url !== undefined) view.url = attempt.url
    if (attempt.userCode !== undefined) view.userCode = attempt.userCode
    if (attempt.message !== undefined) view.message = attempt.message
    if (attempt.prompt !== undefined) view.prompt = attempt.prompt
    if (attempt.error !== undefined) view.error = attempt.error
    if (attempt.abortReason === 'timeout' && attempt.state !== 'authorized') view.status = 'expired'
    return view
  }

  /**
   * Build the safe status the tool reports.
   * @returns {Promise<Record<string, unknown>>} sign-in state, active credential source, and any attempt.
   */
  async function status() {
    const credentials = services?.credentials ?? getService(ctx, 'credentials')
    const read = await readStoredSession(credentials, config)
    const session = read.session !== undefined && read.session.expired !== true ? read.session : undefined
    const apiKeyConfigured = config.apiKey.length > 0
    let activeSource = 'anonymous'
    if (config.authMode === 'api-key') activeSource = apiKeyConfigured ? 'api-key' : 'anonymous'
    else if (config.authMode === 'user') activeSource = session === undefined ? 'none' : 'user-session'
    else activeSource = session !== undefined ? 'user-session' : apiKeyConfigured ? 'api-key' : 'anonymous'
    const staffSource = config.authMode === 'user'
      ? (session === undefined ? 'none' : 'user-session')
      : config.authMode === 'api-key'
        ? (apiKeyConfigured ? 'api-key' : 'anonymous')
        : (session !== undefined && apiKeyConfigured ? 'api-key' : activeSource)
    return {
      baseUrl: config.baseUrl,
      authMode: config.authMode,
      signedIn: session !== undefined,
      storageAvailable: read.storageAvailable,
      apiKeyConfigured,
      activeSource,
      staffSource,
      ...(session === undefined ? {} : { session: publicSession(session) }),
      ...(read.session?.expired === true ? { sessionExpired: true } : {}),
      ...(read.error === undefined ? {} : { sessionError: read.error }),
      ...(attempt === undefined ? {} : { attempt: publicAttempt() }),
      ...(config.authMode === 'user' && session === undefined
        ? { warning: 'authMode is "user" but no valid browser session is stored; run discourse_login with action "start".' }
        : {}),
    }
  }

  /**
   * Reject a pending prompt and release the attempt timer without cancelling
   * another surface's flow.
   * @returns {void}
   */
  function discardAttempt() {
    if (attempt === undefined) return
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    if (typeof attempt.promptReject === 'function') {
      try {
        attempt.promptReject(new Error('the Discourse sign-in attempt ended'))
      } catch {
        // The prompt was already settled.
      }
    }
    attempt = undefined
    activePlan = undefined
  }

  /**
   * Finish an attempt, keeping its outcome for the next status call.
   * @param {{ state: string, error?: string }} next - outcome fields.
   * @returns {void}
   */
  function finishAttempt(next) {
    if (attempt === undefined) return
    attempt.state = next.state
    if (next.error !== undefined) attempt.error = next.error
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    attempt.timer = undefined
    if (typeof attempt.promptReject === 'function') {
      try {
        attempt.promptReject(new Error('the Discourse sign-in attempt ended'))
      } catch {
        // The prompt was already settled.
      }
    }
    attempt.promptResolve = undefined
    attempt.promptReject = undefined
    activePlan = undefined
  }

  /**
   * Cancel the active attempt and the seam's running flow.
   * @returns {void}
   */
  function clearAttempt() {
    if (attempt === undefined) return
    const controller = attempt.controller
    discardAttempt()
    if (services?.authorization !== undefined) {
      try {
        services.authorization.cancel(SESSION_KEY)
      } catch {
        // The seam may already have released the key.
      }
    }
    if (controller !== undefined && controller.signal.aborted !== true) {
      try {
        controller.abort()
      } catch {
        // An already aborted controller is harmless.
      }
    }
  }

  /**
   * Start a browser sign-in, or report the existing session/attempt.
   * @param {{ scopes?: string | string[], force?: boolean, mode?: 'auto' | 'device' | 'manual' }} [options] - requested scopes, restart, and transport preference.
   * @returns {Promise<Record<string, unknown>>} status including the verification URL when pending.
   */
  async function start(options = {}) {
    const { authorization } = requireServices()
    const mode = options.mode === undefined ? 'auto' : String(options.mode).toLowerCase()
    if (mode !== 'auto' && mode !== 'device' && mode !== 'manual') fail('invalid arguments: `mode` must be "auto", "device", or "manual"')
    if (options.force !== true) {
      const current = await status()
      if (current.signedIn === true) return { ...current, alreadySignedIn: true }
    }
    if (attempt !== undefined && (attempt.state === 'pending' || attempt.state === 'starting')) return status()
    if (attempt !== undefined) clearAttempt()
    const scopes = options.scopes === undefined ? config.loginScopes : readLoginScopes(options.scopes)
    let plan
    try {
      plan = createPlan(scopes, mode)
    } catch (error) {
      fail(`could not generate the browser sign-in key pair: ${error instanceof Error ? error.message : String(error)}`)
    }
    const controller = new AbortController()
    let resolveStarted
    const started = new Promise((resolve) => {
      resolveStarted = resolve
    })
    const currentAttempt = {
      state: 'starting',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.loginTimeoutMs).toISOString(),
      controller,
      timer: undefined,
      url: undefined,
      userCode: undefined,
      message: undefined,
      mode: mode === 'manual' ? 'manual' : mode === 'device' ? 'device' : undefined,
      prompt: undefined,
      promptResolve: undefined,
      promptReject: undefined,
      error: undefined,
      abortReason: undefined,
      promise: undefined,
    }
    attempt = currentAttempt
    activePlan = plan
    currentAttempt.timer = setTimeout(() => {
      currentAttempt.abortReason = 'timeout'
      controller.abort()
    }, config.loginTimeoutMs)
    currentAttempt.timer.unref?.()
    const interaction = {
      notify(notice) {
        if (typeof notice?.url === 'string' && notice.url.length > 0) {
          currentAttempt.url = notice.url
          currentAttempt.mode = /\/user-api-key\/activate(?:[?#]|$)/.test(notice.url) ? 'device' : 'manual'
        }
        if (typeof notice?.message === 'string') currentAttempt.message = notice.message
        if (typeof notice?.code === 'string') currentAttempt.userCode = notice.code
        currentAttempt.state = 'pending'
        resolveStarted()
      },
      prompt(question) {
        currentAttempt.mode = 'manual'
        currentAttempt.state = 'pending'
        if (typeof question?.message === 'string') currentAttempt.prompt = question.message
        resolveStarted()
        return new Promise((resolve, reject) => {
          currentAttempt.promptResolve = resolve
          currentAttempt.promptReject = reject
        })
      },
    }
    let beginPromise
    try {
      beginPromise = authorization.begin({ key: SESSION_KEY, signal: controller.signal, interaction })
    } catch (error) {
      discardAttempt()
      throw error
    }
    currentAttempt.promise = beginPromise
    const early = beginPromise.then((outcome) => ({ outcome }), (error) => ({ error }))
    void early.then((result) => {
      resolveStarted()
      if (attempt !== currentAttempt) return
      if (result.error !== undefined) {
        if (result.error?.code === 'ALREADY_IN_FLIGHT') {
          discardAttempt()
          return
        }
        finishAttempt({ state: 'failed', error: result.error instanceof Error ? result.error.message : String(result.error) })
        return
      }
      if (result.outcome?.status === 'authorized') {
        finishAttempt({ state: 'authorized' })
      } else {
        finishAttempt({ state: currentAttempt.abortReason === 'timeout' ? 'expired' : 'cancelled' })
      }
    })
    const first = await raceTimeout(Promise.race([started.then(() => 'started'), early]), 15000)
    if (first !== 'started' && first?.error !== undefined) {
      if (first.error?.code === 'ALREADY_IN_FLIGHT') {
        discardAttempt()
        fail('another Discourse browser sign-in is already in progress; finish or cancel it before starting a new one')
      }
      fail(first.error instanceof Error ? first.error.message : String(first.error))
    }
    const current = await status()
    if (current.attempt?.status === 'failed') fail(String(current.attempt.error ?? 'Discourse browser sign-in failed'))
    if (first?.outcome?.status === 'cancelled') {
      fail(currentAttempt.abortReason === 'timeout'
        ? 'Discourse browser sign-in expired before the authorization page was opened'
        : 'Discourse browser sign-in was cancelled')
    }
    return current
  }

  /**
   * Finish a classic-flow sign-in with the payload the user copied.
   * @param {unknown} input - encrypted payload, redirect URL, or page text.
   * @returns {Promise<Record<string, unknown>>} the signed-in status.
   */
  async function complete(input) {
    requireServices()
    const payload = extractEncryptedPayload(input)
    if (attempt === undefined || attempt.state !== 'pending' || typeof attempt.promptResolve !== 'function') {
      const current = await status()
      if (current.signedIn === true) return { ...current, alreadySignedIn: true }
      if (attempt?.mode === 'device') {
        fail('this Discourse sign-in finishes in the browser; no payload is needed. Run discourse_login with action "status".')
      }
      fail('no Discourse browser sign-in is waiting for a payload; run discourse_login with action "start" first')
    }
    attempt.promptResolve(payload)
    attempt.promptResolve = undefined
    attempt.promptReject = undefined
    let outcome
    try {
      outcome = await withTimeout(attempt.promise, 30000)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    if (outcome?.status !== 'authorized') {
      fail(String(attempt?.error ?? 'Discourse did not authorize the pasted payload'))
    }
    const current = await status()
    if (current.signedIn !== true) fail(String(current.attempt?.error ?? 'Discourse did not store the sign-in'))
    return current
  }

  /**
   * Withdraw a pending browser attempt without touching a stored session.
   * @returns {Promise<Record<string, unknown>>} the resulting status.
   */
  async function cancel() {
    if (disposed) fail('the Discourse plugin is shutting down')
    const hadAttempt = attempt !== undefined && (attempt.state === 'pending' || attempt.state === 'starting')
    let wasInFlight = false
    if (services?.authorization !== undefined && typeof services.authorization.describe === 'function') {
      try {
        wasInFlight = services.authorization.describe(SESSION_KEY)?.inFlight === true
      } catch {
        // A service without describe support still accepts cancel below.
      }
    }
    if (attempt !== undefined) {
      const pending = attempt.promise
      attempt.abortReason = 'cancelled'
      clearAttempt()
      if (pending !== undefined) {
        try {
          await withTimeout(pending, 5000)
        } catch {
          // The seam releases the key when the withdrawn flow settles.
        }
      }
    } else if (services?.authorization !== undefined) {
      try {
        services.authorization.cancel(SESSION_KEY)
      } catch {
        // The seam may already have released the key.
      }
    }
    return { ...(await status()), cancelled: hadAttempt || wasInFlight }
  }

  /**
   * Revoke the stored user API key when possible and delete the local record.
   * @returns {Promise<Record<string, unknown>>} the sign-out result.
   */
  async function logout() {
    if (disposed) fail('the Discourse plugin is shutting down')
    // Stop a running attempt before reading the store: an attempt that already
    // committed would otherwise recreate the record after this sign-out.
    const pending = attempt?.promise
    clearAttempt()
    if (pending !== undefined) {
      try {
        await withTimeout(pending, 10000)
      } catch {
        // A withdrawn attempt may never settle; its commit, if admitted, still completes before the store read.
      }
    }
    const credentials = services?.credentials ?? getService(ctx, 'credentials')
    const read = await readStoredSession(credentials, config)
    if (read.error !== undefined && read.error.startsWith('the stored Discourse sign-in belongs to')) {
      fail(`${read.error}; change baseUrl back or remove the record from the credential store`)
    }
    let revoked = false
    let revokeWarning
    if (read.session !== undefined) {
      try {
        const result = await client.call('POST', '/user-api-key/revoke.json', { userApiKey: read.session.key })
        if (result === null || typeof result !== 'object') throw new Error('the forum returned a non-JSON response to the revoke request')
        revoked = true
      } catch (error) {
        revokeWarning = error instanceof Error ? error.message : String(error)
      }
    }
    if (credentials !== undefined && credentials !== null) {
      try {
        await credentials.deleteRecord(SESSION_KEY)
      } catch (error) {
        fail(`could not delete the stored Discourse sign-in: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      signedOut: true,
      hadSession: read.session !== undefined,
      storageAvailable: read.storageAvailable,
      revoked,
      ...(revokeWarning === undefined ? {} : { revokeWarning }),
    }
  }

  /**
   * Wait for a running attempt, bounded by the caller's requested seconds.
   * @param {number} seconds - wait budget, 0-120.
   * @returns {Promise<Record<string, unknown>>} the resulting status.
   */
  async function waitFor(seconds) {
    const bounded = Math.max(0, Math.min(120, Math.round(Number(seconds) || 0)))
    if (bounded === 0 || attempt?.promise === undefined) return status()
    try {
      await withTimeout(attempt.promise, bounded * 1000)
    } catch {
      // A timeout leaves the attempt running; status reports that.
    }
    return status()
  }

  /**
   * Release the attempt and service references without touching the stored session.
   * @returns {void}
   */
  function dispose() {
    disposed = true
    if (attempt?.controller !== undefined) {
      attempt.abortReason = 'dispose'
      try {
        attempt.controller.abort()
      } catch {
        // An already aborted controller is harmless.
      }
    }
    clearAttempt()
    services = undefined
  }

  return { attach, start, status, complete, cancel, logout, waitFor, dispose }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Project one topic listing row onto the fields a reader needs.
 * @param {Record<string, any>} topic - raw `topic_list.topics` entry.
 * @returns {Record<string, unknown>} the compact topic.
 */
function projectTopic(topic) {
  return {
    id: topic?.id,
    title: topic?.title,
    slug: topic?.slug,
    categoryId: topic?.category_id,
    postsCount: topic?.posts_count,
    replyCount: topic?.reply_count,
    views: topic?.views,
    likeCount: topic?.like_count,
    createdAt: day(topic?.created_at),
    lastPostedAt: day(topic?.last_posted_at),
    pinned: topic?.pinned === true,
    closed: topic?.closed === true,
    tags: Array.isArray(topic?.tags) ? topic.tags.map((tag) => tag?.name ?? tag).filter(Boolean) : [],
    excerpt: clip(toPlainText(topic?.excerpt), 280),
  }
}

/**
 * Project one post onto the fields a reader needs, preferring the raw markup.
 * @param {Record<string, any>} post - raw `post_stream.posts` entry.
 * @param {number} maxBody - characters kept from the body.
 * @returns {Record<string, unknown>} the compact post.
 */
function projectPost(post, maxBody) {
  const body = typeof post?.raw === 'string' && post.raw.length > 0 ? post.raw : toPlainText(post?.cooked)
  return {
    id: post?.id,
    postNumber: post?.post_number,
    username: post?.username,
    createdAt: day(post?.created_at),
    replyToPostNumber: post?.reply_to_post_number ?? null,
    body: clip(body, maxBody),
  }
}

/**
 * Project one user record onto the fields an operator or agent needs.
 * @param {Record<string, any>} user - raw `user` object.
 * @param {Record<string, any>} [summary] - optional summary statistics.
 * @returns {Record<string, unknown>} the compact user.
 */
function projectUser(user, summary) {
  const stats = summary?.user_summary ?? summary ?? {}
  return {
    id: user?.id,
    username: user?.username,
    name: user?.name ?? null,
    trustLevel: user?.trust_level,
    admin: user?.admin === true,
    moderator: user?.moderator === true,
    suspended: user?.suspended === true || (typeof user?.suspended_till === 'string' && user.suspended_till.length > 0),
    suspendedTill: user?.suspended_till ?? null,
    silenced: user?.silenced === true || (typeof user?.silenced_till === 'string' && user.silenced_till.length > 0),
    silencedTill: user?.silenced_till ?? null,
    createdAt: day(user?.created_at),
    lastSeenAt: day(user?.last_seen_at),
    postCount: stats?.post_count ?? user?.post_count,
    topicCount: stats?.topic_count ?? user?.topic_count,
    likesGiven: stats?.likes_given ?? user?.likes_given,
    likesReceived: stats?.likes_received ?? user?.likes_received,
    daysVisited: stats?.days_visited ?? user?.days_visited,
    bio: clip(toPlainText(user?.bio_cooked ?? user?.bio_raw), 300),
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Build every model-facing tool for one client.
 * @param {ReturnType<typeof createClient>} client - the request client.
 * @param {ReturnType<typeof createLogin>} login - the browser sign-in controller.
 * @returns {Array<Record<string, any>>} registry-ready tool definitions.
 */
function buildTools(client, login) {
  const tools = []
  const limit = (value) => integer(value, client.config.maxItems, MAX_LIMIT)
  const page = (value) => integer(value, 1, 10000)

  /**
   * Register one tool through the shared output shape.
   * @param {Record<string, any>} tool - name, description, parameters, execute, and render.
   * @returns {void}
   */
  const add = (tool) => {
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: OBJECT_OUTPUT, render: tool.render },
      ...(tool.presentCall === undefined ? {} : { presentCall: tool.presentCall }),
      execute: tool.execute,
    })
  }

  // --- Reading -------------------------------------------------------------

  add({
    name: 'discourse_search',
    description: 'Search a Discourse forum for topics, posts, and users. Returns matching topics and post blurbs with ids for follow-up reads.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'Discourse search terms. Supports operators such as `#category`, `@username`, `in:title`, and `after:2025-01-01`.' },
        page: { type: 'integer', description: 'Result page, starting at 1.', default: 1 },
        limit: { type: 'integer', description: 'Maximum topics and posts to return, 1-50.', default: 10 },
      },
    },
    async execute(args, exec) {
      const q = requiredString(args?.q, 'q')
      const payload = await client.call('GET', '/search.json', {
        query: { q, page: page(args?.page) },
        signal: exec?.signal,
      })
      const topics = Array.isArray(payload?.topics) ? payload.topics.slice(0, limit(args?.limit)) : []
      const posts = Array.isArray(payload?.posts) ? payload.posts.slice(0, limit(args?.limit)) : []
      const users = Array.isArray(payload?.users) ? payload.users.slice(0, 10) : []
      const grouped = payload?.grouped_search_result ?? {}
      return {
        term: q,
        moreResults: grouped?.more_full_page_results === true || grouped?.more_posts === true,
        topics: topics.map(projectTopic),
        posts: posts.map((post) => ({
          id: post?.id,
          topicId: post?.topic_id,
          postNumber: post?.post_number,
          username: post?.username,
          createdAt: day(post?.created_at),
          blurb: clip(toPlainText(post?.blurb), 280),
        })),
        users: users.map((user) => ({ id: user?.id, username: user?.username, name: user?.name ?? null })),
      }
    },
    render(_args, value) {
      const lines = [`Search results for "${value.term}"`]
      if (value.topics.length > 0) {
        lines.push('', 'Topics:')
        for (const topic of value.topics) {
          lines.push(`- #${topic.id} ${topic.title} (${topic.replyCount ?? 0} replies, ${topic.views ?? 0} views, ${topic.createdAt})`)
          if (topic.excerpt) lines.push(`  ${topic.excerpt}`)
        }
      }
      if (value.posts.length > 0) {
        lines.push('', 'Posts:')
        for (const post of value.posts) {
          lines.push(`- @${post.username} in topic ${post.topicId} (post ${post.postNumber}, ${post.createdAt}): ${post.blurb}`)
        }
      }
      if (value.users.length > 0) {
        lines.push('', `Users: ${value.users.map((user) => `@${user.username}`).join(', ')}`)
      }
      if (value.topics.length === 0 && value.posts.length === 0) lines.push('', 'No matching topics or posts.')
      if (value.moreResults) lines.push('', 'More results are available on a later page.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Search Discourse: ${clip(args?.q, 60)}`, kind: 'search' }
    },
  })

  add({
    name: 'discourse_topics',
    description: 'List forum topics by feed or category. Returns topic ids, titles, reply and view counts, tags, and excerpts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: { type: 'string', enum: ['latest', 'new', 'unread', 'top'], description: 'Which feed to read. Ignored when `category` is set.', default: 'latest' },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'all'], description: 'Ranking window, used only with `filter: top`.', default: 'weekly' },
        category: { type: 'string', description: 'Category slug or numeric id. Lists that category instead of a global feed.' },
        page: { type: 'integer', description: 'Result page, starting at 1.', default: 1 },
        limit: { type: 'integer', description: 'Topics to return, 1-50.', default: 15 },
      },
    },
    async execute(args, exec) {
      const feed = typeof args?.filter === 'string' ? args.filter : 'latest'
      const category = optionalString(args?.category)
      const pageNumber = page(args?.page)
      const perPage = limit(args?.limit)
      let path = '/latest.json'
      let scope = feed
      if (category !== undefined) {
        const resolved = await client.resolveCategory(category, exec?.signal)
        path = `/c/${resolved.slug}/${resolved.id}.json`
        scope = `category ${resolved.slug}`
      } else if (feed === 'top') {
        path = '/top.json'
      } else {
        path = `/${feed}.json`
      }
      const query = { page: pageNumber, per_page: perPage }
      if (category === undefined && feed === 'top') query.period = typeof args?.period === 'string' ? args.period : 'weekly'
      const payload = await client.call('GET', path, { query, signal: exec?.signal })
      const rows = payload?.topic_list?.topics ?? []
      const topics = Array.isArray(rows) ? rows.map(projectTopic) : []
      return {
        scope,
        page: pageNumber,
        topics,
        more: typeof payload?.topic_list?.more_topics_url === 'string' && payload.topic_list.more_topics_url.length > 0,
      }
    },
    render(_args, value) {
      const lines = [`${value.scope} (page ${value.page}, ${value.topics.length} topics)`]
      for (const topic of value.topics) {
        lines.push(`- #${topic.id} ${topic.title} [category ${topic.categoryId}] ${topic.replyCount ?? 0} replies, ${topic.views ?? 0} views, last post ${topic.lastPostedAt}`)
        if (topic.excerpt) lines.push(`  ${topic.excerpt}`)
      }
      if (value.topics.length === 0) lines.push('No topics on this page.')
      if (value.more) lines.push('', 'A further page is available.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Discourse topics: ${clip(args?.category ?? args?.filter ?? 'latest', 40)}`, kind: 'read' }
    },
  })

  add({
    name: 'discourse_topic',
    description: 'Read one topic with its posts. Returns the title, category, tags, and the requested slice of posts; use `page` to read later posts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['topic'],
      properties: {
        topic: { type: 'string', description: 'Topic id, or any topic URL or `/t/slug/1234` path.' },
        page: { type: 'integer', description: 'Post chunk page, starting at 1.', default: 1 },
        limit: { type: 'integer', description: 'Posts to return, 1-40.', default: 12 },
      },
    },
    async execute(args, exec) {
      const id = extractTopicId(args?.topic)
      const payload = await client.call('GET', `/t/${id}.json`, {
        query: { page: page(args?.page) },
        signal: exec?.signal,
      })
      const posts = Array.isArray(payload?.post_stream?.posts) ? payload.post_stream.posts : []
      const maxBody = 900
      return {
        id: payload?.id ?? id,
        title: payload?.title,
        slug: payload?.slug,
        categoryId: payload?.category_id,
        tags: Array.isArray(payload?.tags) ? payload.tags.map((tag) => tag?.name ?? tag).filter(Boolean) : [],
        postsCount: payload?.posts_count,
        views: payload?.views,
        likeCount: payload?.like_count,
        createdAt: day(payload?.created_at),
        lastPostedAt: day(payload?.last_posted_at),
        closed: payload?.closed === true,
        archived: payload?.archived === true,
        posts: posts.slice(0, integer(args?.limit, 12, 40)).map((post) => projectPost(post, maxBody)),
        totalPostsInChunk: posts.length,
      }
    },
    render(_args, value) {
      const lines = [`Topic #${value.id}: ${value.title}`]
      const flags = [value.closed ? 'closed' : '', value.archived ? 'archived' : ''].filter(Boolean).join(', ')
      lines.push(`category ${value.categoryId}, ${value.postsCount ?? '?'} posts, ${value.views ?? 0} views, created ${value.createdAt}${flags ? `, ${flags}` : ''}`)
      if (value.tags.length > 0) lines.push(`tags: ${value.tags.join(', ')}`)
      for (const post of value.posts) {
        lines.push('', `#${post.postNumber} @${post.username} (${post.createdAt})${post.replyToPostNumber ? ` replying to #${post.replyToPostNumber}` : ''}`)
        lines.push(post.body)
      }
      if (value.posts.length === 0) lines.push('', 'No posts on this page.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Read Discourse topic ${clip(args?.topic, 40)}`, kind: 'read' }
    },
  })

  add({
    name: 'discourse_categories',
    description: 'List forum categories with ids, slugs, colors, and topic counts, including subcategories.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      const entries = await client.categories(exec?.signal)
      return {
        categories: entries.slice(0, 100).map((category) => ({
          id: category?.id,
          name: category?.name,
          slug: category?.slug,
          parentId: category?.parent_category_id ?? null,
          topicCount: category?.topic_count,
          color: category?.color,
          description: clip(toPlainText(category?.description_text ?? category?.description), 200),
        })),
        total: entries.length,
      }
    },
    render(_args, value) {
      const lines = [`${value.total} categories`]
      for (const category of value.categories) {
        lines.push(`- ${category.id} ${category.name} (/${category.slug})${category.parentId ? ` in parent ${category.parentId}` : ''}: ${category.topicCount ?? 0} topics`)
        if (category.description) lines.push(`  ${category.description}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall() {
      return { card: 'generic', title: 'List Discourse categories', kind: 'read' }
    },
  })

  add({
    name: 'discourse_user',
    description: 'Read one forum user profile with trust level, roles, suspension state, activity counts, and bio.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username'],
      properties: {
        username: { type: 'string', description: 'Forum username without the leading `@`.' },
      },
    },
    async execute(args, exec) {
      const username = requiredString(args?.username, 'username').replace(/^@/, '')
      const payload = await client.call('GET', `/u/${encodeURIComponent(username)}.json`, { signal: exec?.signal })
      const user = payload?.user ?? payload
      let summary
      try {
        summary = await client.call('GET', `/u/${encodeURIComponent(username)}/summary.json`, { signal: exec?.signal })
      } catch {
        summary = undefined
      }
      return projectUser(user, summary)
    },
    render(_args, value) {
      const roles = [value.admin ? 'admin' : '', value.moderator ? 'moderator' : ''].filter(Boolean).join(', ')
      const lines = [`@${value.username}${value.name ? ` (${value.name})` : ''} — id ${value.id}, trust level ${value.trustLevel ?? '?'}${roles ? `, ${roles}` : ''}`]
      lines.push(`joined ${value.createdAt}, last seen ${value.lastSeenAt}`)
      lines.push(`posts ${value.postCount ?? '?'}, topics ${value.topicCount ?? '?'}, likes given ${value.likesGiven ?? '?'}, likes received ${value.likesReceived ?? '?'}`)
      if (value.suspended) lines.push(`suspended until ${value.suspendedTill ?? 'unknown'}`)
      if (value.silenced) lines.push(`silenced until ${value.silencedTill ?? 'unknown'}`)
      if (value.bio) lines.push('', value.bio)
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Discourse user @${clip(args?.username, 40)}`, kind: 'read' }
    },
  })

  // --- Authoring -----------------------------------------------------------

  add({
    name: 'discourse_create_topic',
    description: 'Create a new forum topic. Returns the new topic and post ids plus the topic URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'raw'],
      properties: {
        title: { type: 'string', description: 'Topic title.' },
        raw: { type: 'string', description: 'Topic body in Markdown.' },
        category: { type: 'string', description: 'Category slug or numeric id. Defaults to the forum default when omitted.' },
        tags: { type: 'array', description: 'Tag names to apply.', items: { type: 'string' } },
      },
    },
    async execute(args, exec) {
      client.writable('creating a topic')
      const body = { title: requiredString(args?.title, 'title'), raw: requiredString(args?.raw, 'raw') }
      if (optionalString(args?.category) !== undefined) {
        const resolved = await client.resolveCategory(args.category, exec?.signal)
        body.category = resolved.id
      }
      if (Array.isArray(args?.tags) && args.tags.length > 0) body.tags = args.tags.map((tag) => String(tag)).slice(0, 10)
      const payload = await client.call('POST', '/posts.json', { body, signal: exec?.signal })
      const topicId = payload?.topic_id
      const slug = payload?.topic_slug
      return {
        topicId,
        postId: payload?.id,
        postNumber: payload?.post_number,
        title: body.title,
        url: topicId === undefined ? undefined : slug ? `${client.config.baseUrl}/t/${slug}/${topicId}` : `${client.config.baseUrl}/t/${topicId}`,
      }
    },
    render(_args, value) {
      return [{ type: 'text', text: `Created topic #${value.topicId} with post #${value.postId}.\n${value.url ?? ''}` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Create topic: ${clip(args?.title, 60)}`, kind: 'edit' }
    },
  })

  add({
    name: 'discourse_reply',
    description: 'Append a reply to an existing topic. Returns the new post id, post number, and URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'raw'],
      properties: {
        topic: { type: 'string', description: 'Topic id, or any topic URL or `/t/slug/1234` path.' },
        raw: { type: 'string', description: 'Reply body in Markdown.' },
        replyToPostNumber: { type: 'integer', description: 'Post number inside the topic to reply to directly.' },
      },
    },
    async execute(args, exec) {
      client.writable('replying to a topic')
      const topicId = extractTopicId(args?.topic)
      const body = { topic_id: topicId, raw: requiredString(args?.raw, 'raw') }
      if (typeof args?.replyToPostNumber === 'number') body.reply_to_post_number = requiredInteger(args.replyToPostNumber, 'replyToPostNumber')
      const payload = await client.call('POST', '/posts.json', { body, signal: exec?.signal })
      return {
        topicId,
        postId: payload?.id,
        postNumber: payload?.post_number,
        url: `${client.config.baseUrl}/t/${topicId}/${payload?.post_number ?? 1}`,
      }
    },
    render(_args, value) {
      return [{ type: 'text', text: `Replied to topic #${value.topicId} as post #${value.postId} (#${value.postNumber}).\n${value.url}` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Reply in topic ${clip(args?.topic, 30)}`, kind: 'edit' }
    },
  })

  add({
    name: 'discourse_update_post',
    description: 'Replace the body of an existing post. Returns the post id and its new version.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['postId', 'raw'],
      properties: {
        postId: { type: 'integer', description: 'Numeric post id.' },
        raw: { type: 'string', description: 'Replacement body in Markdown.' },
        editReason: { type: 'string', description: 'Optional edit reason shown in the post revision history.' },
      },
    },
    async execute(args, exec) {
      client.writable('editing a post')
      const postId = requiredInteger(args?.postId, 'postId')
      const post = { raw: requiredString(args?.raw, 'raw') }
      if (optionalString(args?.editReason) !== undefined) post.edit_reason = optionalString(args.editReason)
      const payload = await client.call('PUT', `/posts/${postId}.json`, { body: { post }, signal: exec?.signal })
      return {
        postId,
        version: payload?.version,
        updatedAt: day(payload?.updated_at),
      }
    },
    render(_args, value) {
      return [{ type: 'text', text: `Updated post #${value.postId} to version ${value.version ?? '?'} (${value.updatedAt}).` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Edit post #${args?.postId ?? '?'}`, kind: 'edit' }
    },
  })

  add({
    name: 'discourse_flag_post',
    description: 'Flag a post for moderator attention. Returns the flag type recorded against the post.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['postId', 'flag'],
      properties: {
        postId: { type: 'integer', description: 'Numeric post id.' },
        flag: { type: 'string', enum: ['spam', 'inappropriate', 'off_topic', 'notify_user', 'notify_moderators'], description: 'Reason to flag the post.' },
        message: { type: 'string', description: 'Private note for moderators, required by `notify_user` and `notify_moderators`.' },
      },
    },
    async execute(args, exec) {
      client.writable('flagging a post')
      const postId = requiredInteger(args?.postId, 'postId')
      const flag = requiredString(args?.flag, 'flag')
      const actionType = FLAG_TYPES[flag]
      if (actionType === undefined) fail(`invalid arguments: \`flag\` must be one of ${Object.keys(FLAG_TYPES).join(', ')}`)
      const body = { id: postId, post_action_type_id: actionType, flag_topic: false }
      const message = optionalString(args?.message)
      if (message !== undefined) body.message = message
      await client.call('POST', '/post_actions.json', { body, signal: exec?.signal })
      return { postId, flag, actionType }
    },
    render(_args, value) {
      return [{ type: 'text', text: `Flagged post #${value.postId} as ${value.flag}.` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Flag post #${args?.postId ?? '?'}`, kind: 'other' }
    },
  })

  // --- Moderation ----------------------------------------------------------

  add({
    name: 'discourse_review_queue',
    description: 'List the moderator review queue. Returns flagged posts and users awaiting a decision, with the ids used by review actions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['pending', 'reviewed', 'all'], description: 'Which reviewables to list.', default: 'pending' },
        limit: { type: 'integer', description: 'Items to return, 1-50.', default: 20 },
      },
    },
    async execute(args, exec) {
      const status = typeof args?.status === 'string' ? args.status : 'pending'
      const payload = await client.call('GET', '/review.json', { query: { status }, signal: exec?.signal, privileged: true })
      const rows = Array.isArray(payload?.reviewables) ? payload.reviewables : Array.isArray(payload) ? payload : []
      const reviewables = rows.slice(0, limit(args?.limit)).map((item) => ({
        id: item?.id,
        type: item?.type,
        status: item?.status,
        createdAt: day(item?.created_at),
        topicId: item?.topic?.id ?? item?.target?.topic_id ?? null,
        title: item?.topic?.title ?? item?.payload?.title ?? null,
        username: item?.target?.username ?? item?.payload?.username ?? null,
        excerpt: clip(toPlainText(item?.payload?.cooked ?? item?.target?.excerpt), 240),
      }))
      return { status, reviewables, total: rows.length }
    },
    render(_args, value) {
      const lines = [`Review queue (${value.status}): ${value.total} items`]
      for (const item of value.reviewables) {
        lines.push(`- #${item.id} ${item.type} (${item.status}, ${item.createdAt})${item.username ? ` by @${item.username}` : ''}${item.topicId ? ` in topic ${item.topicId}` : ''}`)
        if (item.title) lines.push(`  ${item.title}`)
        if (item.excerpt) lines.push(`  ${item.excerpt}`)
      }
      if (value.reviewables.length === 0) lines.push('Nothing is waiting for review.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall() {
      return { card: 'generic', title: 'Discourse review queue', kind: 'read' }
    },
  })

  add({
    name: 'discourse_delete_post',
    description: 'Delete a post. Returns the post id and whether the deletion was permanent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['postId'],
      properties: {
        postId: { type: 'integer', description: 'Numeric post id.' },
        permanent: { type: 'boolean', description: 'Permanently destroy instead of keeping a recoverable deletion.', default: false },
      },
    },
    async execute(args, exec) {
      client.writable('deleting a post')
      const postId = requiredInteger(args?.postId, 'postId')
      const permanent = args?.permanent === true
      await client.call('DELETE', `/posts/${postId}.json`, {
        query: permanent ? { force_destroy: 'true' } : {},
        signal: exec?.signal,
        privileged: true,
      })
      return { postId, permanent, deleted: true }
    },
    render(_args, value) {
      return [{ type: 'text', text: value.permanent ? `Permanently deleted post #${value.postId}.` : `Deleted post #${value.postId}; staff can restore it.` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Delete post #${args?.postId ?? '?'}`, kind: 'delete' }
    },
  })

  add({
    name: 'discourse_restore_post',
    description: 'Restore a previously deleted post. Returns the post id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['postId'],
      properties: {
        postId: { type: 'integer', description: 'Numeric post id.' },
      },
    },
    async execute(args, exec) {
      client.writable('restoring a post')
      const postId = requiredInteger(args?.postId, 'postId')
      await client.call('PUT', `/posts/${postId}/recover.json`, { signal: exec?.signal, privileged: true })
      return { postId, restored: true }
    },
    render(_args, value) {
      return [{ type: 'text', text: `Restored post #${value.postId}.` }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Restore post #${args?.postId ?? '?'}`, kind: 'edit' }
    },
  })

  // --- Administration ------------------------------------------------------

  add({
    name: 'discourse_admin_users',
    description: 'List or search forum users through the admin directory. Returns ids, roles, trust level, suspension state, and activity counts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Matches username, name, or email.' },
        status: { type: 'string', enum: ['active', 'new', 'suspended', 'silenced', 'staff', 'admins', 'moderators', 'all'], description: 'Directory filter.', default: 'active' },
        order: { type: 'string', enum: ['username', 'email', 'created', 'last_seen', 'post_count'], description: 'Sort column.', default: 'created' },
        page: { type: 'integer', description: 'Result page, starting at 1.', default: 1 },
        limit: { type: 'integer', description: 'Users to return, 1-100.', default: 25 },
      },
    },
    async execute(args, exec) {
      const query = { page: page(args?.page), order: typeof args?.order === 'string' ? args.order : 'created' }
      const status = typeof args?.status === 'string' ? args.status : 'active'
      if (status !== 'all') query.status = status
      if (optionalString(args?.query) !== undefined) query.query = optionalString(args.query)
      const payload = await client.call('GET', '/admin/users.json', { query, signal: exec?.signal, privileged: true })
      const rows = Array.isArray(payload) ? payload : payload?.users ?? []
      const users = (Array.isArray(rows) ? rows : []).slice(0, integer(args?.limit, 25, 100)).map((user) => ({
        id: user?.id,
        username: user?.username,
        name: user?.name ?? null,
        email: user?.email ?? null,
        trustLevel: user?.trust_level,
        admin: user?.admin === true,
        moderator: user?.moderator === true,
        suspended: user?.suspended_till !== undefined && user?.suspended_till !== null,
        suspendedTill: user?.suspended_till ?? null,
        silencedTill: user?.silenced_till ?? null,
        createdAt: day(user?.created_at),
        lastSeenAt: day(user?.last_seen_at),
        postCount: user?.post_count,
        flagsReceived: user?.flags_received_count ?? null,
      }))
      return { status, page: query.page, users, total: payload?.meta?.total ?? payload?.total ?? users.length }
    },
    render(_args, value) {
      const lines = [`Admin directory (${value.status}, page ${value.page}): ${value.total} matches`]
      for (const user of value.users) {
        const roles = [user.admin ? 'admin' : '', user.moderator ? 'moderator' : ''].filter(Boolean).join('/')
        lines.push(`- #${user.id} @${user.username}${user.name ? ` (${user.name})` : ''} TL${user.trustLevel ?? '?'}${roles ? ` [${roles}]` : ''}, ${user.postCount ?? 0} posts, last seen ${user.lastSeenAt}`)
        if (user.suspendedTill) lines.push(`  suspended until ${day(user.suspendedTill)}`)
        if (user.silencedTill) lines.push(`  silenced until ${day(user.silencedTill)}`)
      }
      if (value.users.length === 0) lines.push('No users match this filter.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall() {
      return { card: 'generic', title: 'Discourse user directory', kind: 'search' }
    },
  })

  add({
    name: 'discourse_moderate_user',
    description: 'Suspend, silence, lift a sanction, or activate a forum account. Returns the account state after the change.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'action'],
      properties: {
        username: { type: 'string', description: 'Forum username without the leading `@`.' },
        action: { type: 'string', enum: ['suspend', 'silence', 'unsuspend', 'unsilence', 'activate'], description: 'Account change to apply.' },
        until: { type: 'string', description: 'End of the sanction as an ISO date such as `2026-12-31`. Required by `suspend` and `silence`.' },
        reason: { type: 'string', description: 'Staff-only reason recorded with the change.' },
        message: { type: 'string', description: 'Message shown to the user, when the action supports one.' },
      },
    },
    async execute(args, exec) {
      client.writable('moderating a user')
      const username = requiredString(args?.username, 'username').replace(/^@/, '')
      const action = requiredString(args?.action, 'action')
      const userId = await resolveUserId(client, username, exec?.signal, { privileged: true })
      if (action === 'suspend' || action === 'silence') {
        const until = requiredString(args?.until, 'until')
        const body = action === 'suspend' ? { suspend_until: until } : { silenced_till: until }
        if (optionalString(args?.reason) !== undefined) body.reason = optionalString(args.reason)
        if (optionalString(args?.message) !== undefined) body.message = optionalString(args.message)
        await client.call('PUT', `/admin/users/${userId}/${action}.json`, { body, signal: exec?.signal, privileged: true })
        return { userId, username, action, until }
      }
      if (action === 'activate') {
        await client.call('PUT', `/admin/users/${userId}/activate.json`, { signal: exec?.signal, privileged: true })
        return { userId, username, action }
      }
      const lifted = action === 'unsuspend' ? 'suspend' : 'silence'
      await client.call('DELETE', `/admin/users/${userId}/${lifted}.json`, { signal: exec?.signal, privileged: true })
      return { userId, username, action }
    },
    render(_args, value) {
      const text = value.until === undefined
        ? `Applied ${value.action} to @${value.username} (id ${value.userId}).`
        : `Applied ${value.action} to @${value.username} (id ${value.userId}) until ${value.until}.`
      return [{ type: 'text', text }]
    },
    presentCall(args) {
      return { card: 'generic', title: `${clip(args?.action, 20) || 'Moderate'} @${clip(args?.username, 30)}`, kind: 'other' }
    },
  })

  add({
    name: 'discourse_site_settings',
    description: 'Read or change forum site settings. Returns matching settings with their current values.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'Read settings or write one.', default: 'get' },
        name: { type: 'string', description: 'Exact setting name, required by `set`.' },
        filter: { type: 'string', description: 'Only return settings whose name contains this text.' },
        value: { type: 'string', description: 'New value for `set`; pass JSON-compatible text for booleans and numbers.' },
      },
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'get'
      if (action === 'set') {
        client.writable('changing a site setting')
        const name = requiredString(args?.name, 'name')
        if (args?.value === undefined) fail('invalid arguments: `value` is required when `action` is `set`')
        await client.call('PUT', `/admin/site_settings/${encodeURIComponent(name)}.json`, {
          body: { [name]: coerceSettingValue(args.value) },
          signal: exec?.signal,
          privileged: true,
        })
        return { updated: true, name, value: args.value }
      }
      const payload = await client.call('GET', '/admin/site_settings.json', { signal: exec?.signal, privileged: true })
      const rows = Array.isArray(payload) ? payload : payload?.site_settings ?? []
      const filter = optionalString(args?.filter)?.toLowerCase()
      const name = optionalString(args?.name)?.toLowerCase()
      const settings = (Array.isArray(rows) ? rows : [])
        .filter((row) => {
          const key = String(row?.setting ?? '').toLowerCase()
          if (name !== undefined && key !== name) return false
          if (filter !== undefined && !key.includes(filter)) return false
          return true
        })
        .slice(0, 25)
        .map((row) => ({
          name: row?.setting,
          value: row?.value,
          kind: row?.type ?? null,
          description: clip(toPlainText(row?.description), 160),
        }))
      return { settings, matched: settings.length }
    },
    render(_args, value) {
      if (value.updated === true) return [{ type: 'text', text: `Set ${value.name} to ${JSON.stringify(value.value)}.` }]
      const lines = [`${value.matched} settings`]
      for (const setting of value.settings) lines.push(`- ${setting.name} = ${JSON.stringify(setting.value)}`)
      if (value.settings.length === 0) lines.push('No settings match this filter.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: args?.action === 'set' ? `Set ${clip(args?.name, 40)}` : 'Read Discourse settings', kind: 'other' }
    },
  })

  add({
    name: 'discourse_admin_stats',
    description: 'Read one admin dashboard report as a time series. Returns labelled data points for the requested window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        report: {
          type: 'string',
          enum: ['active_users', 'signups', 'topics', 'posts', 'likes', 'flags', 'page_views', 'visits', 'users_by_trust_level', 'new_contributors', 'daily_engaged_users'],
          description: 'Dashboard report to read.',
          default: 'topics',
        },
        days: { type: 'integer', description: 'Length of the window ending today, 1-365.', default: 30 },
      },
    },
    async execute(args, exec) {
      const report = typeof args?.report === 'string' ? args.report : 'topics'
      const days = integer(args?.days, 30, 365)
      const end = new Date()
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
      const payload = await client.call('GET', `/admin/reports/${report}.json`, {
        query: { start_date: isoDay(start), end_date: isoDay(end) },
        signal: exec?.signal,
        privileged: true,
      })
      const body = payload?.report ?? payload ?? {}
      const points = Array.isArray(body?.data) ? body.data.slice(-days) : []
      return {
        report,
        title: body?.title ?? report,
        total: body?.total ?? null,
        labels: body?.labels ?? null,
        points: points.map((point) => ({ x: point?.x, y: point?.y })),
      }
    },
    render(_args, value) {
      const lines = [`${value.title}${value.total === null ? '' : ` (total ${value.total})`}`]
      for (const point of value.points) lines.push(`- ${point.x}: ${point.y}`)
      if (value.points.length === 0) lines.push('The report returned no data points.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: `Discourse report: ${clip(args?.report ?? 'topics', 30)}`, kind: 'read' }
    },
  })

  add({
    name: 'discourse_login',
    description: 'Sign in to Discourse through the user\'s browser and inspect or end the stored session. `start` returns a verification URL and code for the forum authorization page; after the user approves it, call `status` (optionally with `waitSeconds`) to collect the signed-in account. `complete` finishes older forums that display an encrypted payload to paste, `cancel` withdraws a pending attempt, and `logout` revokes the user API key. A signed-in user API key is scoped to that account; with `authMode: auto`, staff and admin tools keep using the configured apiKey.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'complete', 'cancel', 'logout'], description: 'Operation to perform. `start` begins browser authorization, `status` reports the stored session and any pending attempt, `complete` accepts the encrypted payload from an older forum, `cancel` withdraws a pending attempt, and `logout` revokes the session.', default: 'status' },
        scopes: { type: 'string', description: 'Comma-separated scopes for `start`, overriding `loginScopes`; for example `read,session_info` for a read-only session.' },
        mode: { type: 'string', enum: ['auto', 'device', 'manual'], description: 'How `start` obtains authorization. `auto` uses Discourse\'s device code and falls back to the classic payload page, `device` requires the device code, and `manual` always uses the classic page.', default: 'auto' },
        force: { type: 'boolean', description: 'With `start`, authorize a new session even when one is already stored.', default: false },
        payload: { type: 'string', description: 'With `complete`, the encrypted payload shown by an older Discourse page after approval, or its full redirect URL.' },
        waitSeconds: { type: 'integer', description: 'With `status`, wait up to this many seconds for a pending browser sign-in before reporting, 0-120.', default: 0 },
      },
    },
    async execute(args, _exec) {
      const action = typeof args?.action === 'string' ? args.action : 'status'
      if (action === 'start') return login.start({ scopes: args?.scopes, mode: args?.mode, force: args?.force === true })
      if (action === 'status') {
        const wait = typeof args?.waitSeconds === 'number' ? integer(args.waitSeconds, 0, 120, 0) : 0
        return wait > 0 ? login.waitFor(wait) : login.status()
      }
      if (action === 'complete') return login.complete(args?.payload)
      if (action === 'cancel') return login.cancel()
      if (action === 'logout') return login.logout()
      fail('invalid arguments: `action` must be one of start, status, complete, cancel, or logout')
    },
    render(_args, value) {
      if (value.signedOut === true) {
        const lines = [value.revoked === true ? 'Signed out of Discourse and revoked the stored user API key.' : 'Signed out of Discourse.']
        if (value.revokeWarning !== undefined) lines.push(`The forum did not confirm revocation: ${value.revokeWarning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      }
      if (value.signedIn === true) {
        const user = value.session?.username ? `@${value.session.username}` : 'the stored account'
        const lines = [`Signed in to ${value.baseUrl} as ${user}.`]
        if (value.cancelled === true) lines.push('Cancelled the pending browser sign-in.')
        if (Array.isArray(value.session?.scopes) && value.session.scopes.length > 0) lines.push(`Scopes: ${value.session.scopes.join(', ')}`)
        if (value.session?.expiresAt) lines.push(`Key expires: ${value.session.expiresAt}`)
        if (value.alreadySignedIn === true) lines.push('A browser sign-in is already stored; pass `force: true` to authorize again.')
        if (value.activeSource) lines.push(`Active credential: ${value.activeSource}`)
        if (value.attempt?.status === 'failed') lines.push(`The last sign-in attempt failed: ${value.attempt.error ?? 'unknown error'}`)
        else if (value.attempt?.status === 'expired') lines.push('The last sign-in attempt expired; start again if you need a fresh key.')
        return [{ type: 'text', text: lines.join('\n') }]
      }
      const lines = [`Not signed in to ${value.baseUrl}.`]
      if (value.cancelled === true) lines.push('Cancelled the pending browser sign-in.')
      if (value.apiKeyConfigured === true) lines.push('The configured API key is used when no browser session is stored.')
      if (value.sessionExpired === true) lines.push('The stored session has expired; start a new sign-in.')
      if (value.sessionError) lines.push(`Stored session problem: ${value.sessionError}`)
      if (value.warning) lines.push(value.warning)
      const attempt = value.attempt
      if (attempt !== undefined) {
        if (attempt.status === 'pending' || attempt.status === 'starting') {
          lines.push('', `Browser sign-in ${attempt.status}.`)
          if (attempt.mode) lines.push(`Mode: ${attempt.mode}`)
          if (attempt.url) lines.push(`Open: ${attempt.url}`)
          if (attempt.userCode) lines.push(`Code: ${attempt.userCode}`)
          if (attempt.prompt) lines.push(attempt.prompt)
          if (attempt.expiresAt) lines.push(`Expires: ${attempt.expiresAt}`)
          lines.push('After approving in the browser, run discourse_login with action "status".')
        } else if (attempt.status === 'failed') {
          lines.push('', `Browser sign-in failed: ${attempt.error ?? 'unknown error'}`)
        } else if (attempt.status === 'expired') {
          lines.push('', 'Browser sign-in expired; start again.')
        } else if (attempt.status === 'cancelled') {
          lines.push('', 'Browser sign-in was cancelled.')
        }
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentCall(args) {
      return { card: 'generic', title: args?.action === 'start' ? 'Sign in to Discourse' : `Discourse login: ${clip(args?.action ?? 'status', 20)}`, kind: 'other' }
    },
  })

  return tools
}

// ---------------------------------------------------------------------------
// Tool support
// ---------------------------------------------------------------------------

/** Post action ids used by the flag endpoint. */
const FLAG_TYPES = {
  off_topic: 3,
  inappropriate: 4,
  spam: 6,
  notify_user: 7,
  notify_moderators: 8,
}

/**
 * Extract a topic id from a bare id, a numeric argument, a `/t/slug/1234` path, or a full URL.
 * @param {unknown} input - model-supplied topic reference.
 * @returns {number} the topic id.
 */
function extractTopicId(input) {
  if (typeof input === 'number' && Number.isInteger(input) && input > 0) return input
  if (typeof input !== 'string' || input.trim().length === 0) {
    fail('invalid arguments: `topic` must be a topic id or topic URL')
  }
  const text = input.trim()
  if (/^\d+$/.test(text)) return Number(text)
  const match = /\/(\d+)(?:\/|$|\?|#)/.exec(text) ?? /(\d+)\s*$/.exec(text)
  if (match !== null) return Number(match[1])
  fail(`invalid arguments: \`topic\` must be a topic id or topic URL, got ${JSON.stringify(input)}`)
}

/**
 * Resolve a username to its numeric id for admin routes.
 * @param {ReturnType<typeof createClient>} client - the request client.
 * @param {string} username - forum username.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @param {{ privileged?: boolean }} [options] - staff/admin request intent.
 * @returns {Promise<number>} the user id.
 */
async function resolveUserId(client, username, signal, options = {}) {
  if (/^\d+$/.test(username)) return Number(username)
  const payload = await client.call('GET', `/u/${encodeURIComponent(username)}.json`, { signal, privileged: options.privileged === true })
  const id = payload?.user?.id ?? payload?.id
  if (typeof id !== 'number') fail(`could not resolve @${username} to a user id on ${client.config.baseUrl}`)
  return id
}

/**
 * Interpret a setting value written as text.
 * @param {unknown} value - model-supplied value.
 * @returns {unknown} the JSON value a Discourse setting expects.
 */
function coerceSettingValue(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (/^[[{"]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return value
    }
  }
  return value
}

/**
 * Format a date as `YYYY-MM-DD` in UTC.
 * @param {Date} date - the instant to format.
 * @returns {string} the calendar date.
 */
function isoDay(date) {
  return date.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register every Discourse tool for the lifetime of this plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context carrying the tool registry.
 * @param {unknown} config - loader row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = readConfig(config)
  const client = createClient(resolved, () => getService(ctx, 'credentials'))
  const login = createLogin(ctx, resolved, client)
  const tools = buildTools(client, login)
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `discourse:${tool.name}`)
  }
  if (login.attach(ctx) !== true && typeof ctx.inject === 'function') {
    ctx.inject(['credentials', 'authorization'], (scope) => login.attach(scope))
  }
  ctx.effect(() => () => login.dispose(), 'discourse:login lifetime')
}
