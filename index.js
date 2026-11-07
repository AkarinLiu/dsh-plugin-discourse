/**
 * Discourse administration and agent tools for the DeepSeek Harness.
 *
 * One Host plugin registers model-facing tools over the Discourse REST API:
 * reading topics and users, authoring posts, and running moderator/administrator
 * operations. Every request carries the configured API key, and `readOnly`
 * turns the plugin into an inspection-only surface.
 *
 * @module dsh-plugin-discourse
 */

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
 * shared profile file never needs to carry the secret itself.
 *
 * @param {unknown} raw - the loader row config object.
 * @returns {{ baseUrl: string, apiKey: string, apiUsername: string, readOnly: boolean, timeoutMs: number, maxItems: number }} the resolved configuration.
 */
function readConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const declared = optionalString(source.baseUrl) ?? DEFAULT_BASE_URL
  let baseUrl
  try {
    const parsed = new URL(declared)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('unsupported protocol')
    baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    fail(`invalid config: \`baseUrl\` must be an http(s) URL, got ${JSON.stringify(declared)}`)
  }
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
  return {
    baseUrl,
    apiKey,
    apiUsername,
    readOnly: source.readOnly === true,
    timeoutMs,
    maxItems,
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * Build the request client shared by every tool of one activation.
 * @param {ReturnType<typeof readConfig>} config - resolved configuration.
 * @returns {{ call: Function, writable: Function, categories: Function, resolveCategory: Function, config: object }} the client.
 */
function createClient(config) {
  const cache = { at: 0, entries: [] }

  /**
   * Issue one Discourse request and decode its JSON body.
   * @param {string} method - HTTP method.
   * @param {string} path - absolute path such as `/latest.json`.
   * @param {{ query?: Record<string, unknown>, body?: unknown, signal?: AbortSignal }} [options] - query values, JSON body, and caller cancellation.
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

    const headers = { Accept: 'application/json' }
    if (config.apiKey.length > 0) {
      headers['Api-Key'] = config.apiKey
      headers['Api-Username'] = config.apiUsername
    }
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

    const text = await response.text()
    let payload
    try {
      payload = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      payload = text
    }

    if (!response.ok) {
      const detail = describeError(payload)
      const hint = response.status === 403
        ? ' The API key needs an admin-scoped key for this endpoint.'
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
 * @returns {Array<Record<string, any>>} registry-ready tool definitions.
 */
function buildTools(client) {
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
      const payload = await client.call('GET', '/review.json', { query: { status }, signal: exec?.signal })
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
      await client.call('PUT', `/posts/${postId}/recover.json`, { signal: exec?.signal })
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
      const payload = await client.call('GET', '/admin/users.json', { query, signal: exec?.signal })
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
      const userId = await resolveUserId(client, username, exec?.signal)
      if (action === 'suspend' || action === 'silence') {
        const until = requiredString(args?.until, 'until')
        const body = action === 'suspend' ? { suspend_until: until } : { silenced_till: until }
        if (optionalString(args?.reason) !== undefined) body.reason = optionalString(args.reason)
        if (optionalString(args?.message) !== undefined) body.message = optionalString(args.message)
        await client.call('PUT', `/admin/users/${userId}/${action}.json`, { body, signal: exec?.signal })
        return { userId, username, action, until }
      }
      if (action === 'activate') {
        await client.call('PUT', `/admin/users/${userId}/activate.json`, { signal: exec?.signal })
        return { userId, username, action }
      }
      const lifted = action === 'unsuspend' ? 'suspend' : 'silence'
      await client.call('DELETE', `/admin/users/${userId}/${lifted}.json`, { signal: exec?.signal })
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
        })
        return { updated: true, name, value: args.value }
      }
      const payload = await client.call('GET', '/admin/site_settings.json', { signal: exec?.signal })
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
 * @returns {Promise<number>} the user id.
 */
async function resolveUserId(client, username, signal) {
  if (/^\d+$/.test(username)) return Number(username)
  const payload = await client.call('GET', `/u/${encodeURIComponent(username)}.json`, { signal })
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
  const client = createClient(readConfig(config))
  const tools = buildTools(client)
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `discourse:${tool.name}`)
  }
}
