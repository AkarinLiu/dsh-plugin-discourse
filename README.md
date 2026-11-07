# dsh-plugin-discourse

[![npm](https://img.shields.io/npm/v/dsh-plugin-discourse.svg)](https://www.npmjs.com/package/dsh-plugin-discourse)

Discourse administration and agent tools for the [DeepSeek Harness](https://github.com/deepseek-ai).

One Host plugin registers 16 model-facing tools over the Discourse REST API: an agent can search a
forum, read topics and profiles, publish posts, and carry out the moderator and administrator work a
staff account would do in the web UI.

```
User → DSH agent → discourse_* tools → Discourse REST API → forum
```

## Tools

| Tool | Group | What it does | Key needed |
|---|---|---|---|
| `discourse_search` | read | Search topics, posts, and users | no |
| `discourse_topics` | read | List a feed (`latest`/`new`/`unread`/`top`) or one category | no |
| `discourse_topic` | read | Read a topic and a slice of its posts | no |
| `discourse_categories` | read | List categories and subcategories with ids | no |
| `discourse_user` | read | Read one profile with roles, trust level, and activity counts | no |
| `discourse_create_topic` | author | Create a topic with category and tags | yes |
| `discourse_reply` | author | Reply to a topic, optionally to a specific post | yes |
| `discourse_update_post` | author | Replace a post body | yes |
| `discourse_flag_post` | author | Flag a post as spam, inappropriate, or off-topic | yes |
| `discourse_review_queue` | moderate | List flagged items awaiting a decision | moderator |
| `discourse_delete_post` | moderate | Delete or permanently destroy a post | moderator |
| `discourse_restore_post` | moderate | Restore a deleted post | moderator |
| `discourse_admin_users` | admin | Search the user directory by status and order | admin |
| `discourse_moderate_user` | admin | Suspend, silence, lift a sanction, or activate an account | admin |
| `discourse_site_settings` | admin | Read settings, or change one by name | admin |
| `discourse_admin_stats` | admin | Read a dashboard report as a time series | admin |

Every listing is bounded (12 items by default, 50 maximum) and every post body is clipped, so a
thread search never floods the model context. Results keep ids, so a follow-up call reads the detail.

## Install

The bundle is a profile plugin: it is installed into one DSH profile and selected in that profile's
bundle list.

**From npm** — the package is published as
[`dsh-plugin-discourse`](https://www.npmjs.com/package/dsh-plugin-discourse). The launcher passes
everything after `plugin` to pnpm:

```bash
dsh plugin --profile desktop add dsh-plugin-discourse
```

**From the Web UI** — open *Settings → Plugins → Install bundle* and give it `dsh-plugin-discourse`
for the npm package, or `github:AkarinLiu/dsh-plugin-discourse`, or a local clone path. DSH installs
the package, adds it to the profile's bundle list, and activates it.

**From a clone** — `gh repo clone AkarinLiu/dsh-plugin-discourse`, then
`dsh plugin --profile desktop add ./dsh-plugin-discourse`.

After a CLI install, select `dsh-plugin-discourse` once in the Plugins page (or through the
`plugin_manager` tool) so the profile records it as a bundle.

To remove it, uninstall the bundle from the Plugins page, which drops the dependency and the bundle
entry together.

> The plugin is Host-only: no build step, no dependencies, no client assets.

## Configure

The bundle ships its defaults in `cordis.patch.yml`, which DSH applies as the bundle layer. To point
it at your forum, add an override to your **profile's** `cordis.patch.yml` (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- id: discourse
  name: dsh-plugin-discourse
  config:
    baseUrl: https://forum.example.com
    apiKey: ''
    apiUsername: ''
    readOnly: true
    timeoutMs: 20000
    maxItems: 12
```

A loader override replaces the row's `config` wholesale, so restate every key you want to keep.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://meta.discourse.org` | Forum origin. Point this at your own forum. |
| `apiKey` | `''` | Discourse API key. Empty means anonymous, read-only access. |
| `apiUsername` | `''` → `system` | Username the key acts as. |
| `readOnly` | `false` | Blocks every mutating tool when `true`. |
| `timeoutMs` | `20000` | Per-request deadline, 1000–120000. |
| `maxItems` | `12` | Default listing size, 1–50. |

Anonymous reads work out of the box against the default forum, so you can try `discourse_topics`
before configuring anything.

### Credentials

Generate a key in Discourse under *Admin → API → API keys*. Two shapes work:

- **Global key with an admin user** — full tool coverage, including `discourse_admin_*`.
- **Granular key** — grant only the scopes you want (`topics:write`, `posts:write`, `users:moderate`,
  and similar). Any tool whose scope is missing fails with the forum's own 403 message.

Rather than storing the secret in YAML, the plugin also reads it from the environment:

```bash
export DISCOURSE_API_KEY="..."
export DISCOURSE_API_USERNAME="staff-bot"
```

Row config wins over the environment when both are present.

## Safety

- `readOnly: true` is enforced inside the plugin, before any mutating request is built.
- `discourse_moderate_user` and the site-settings tools require an admin-scoped key; a key without
  those scopes receives the forum's 403 response, and the tool reports it instead of retrying.
- Failures carry the HTTP status and Discourse's own error text, so a wrong id or a missing scope is
  visible in the transcript.
- Writes should be exercised with a staging forum first — `discourse_delete_post` with
  `permanent: true` is irreversible.

## Development

The package is plain ESM with no runtime dependencies; `index.js` is the whole plugin.

```bash
node --check index.js          # syntax
node scripts/smoke.mjs         # register every tool and validate definitions offline
node scripts/smoke.mjs --live  # additionally call read-only tools against the configured forum
```

`scripts/smoke.mjs` drives `apply()` with a stub context, so it exercises the real registration path
without starting a Harness.

## 中文说明

- 这是一个 **Host 插件**，向 DSH 智能体提供 16 个 Discourse 工具（读取 / 发帖 / 版主 / 管理员）。
- 安装：`dsh plugin --profile desktop add dsh-plugin-discourse`（已发布到 npm），或在 Web UI 的 *设置 → 插件 → 安装 bundle* 中填入 `dsh-plugin-discourse` / `github:AkarinLiu/dsh-plugin-discourse`。
- 配置：在 profile 的 `cordis.patch.yml` 中加一条 `id: discourse` 的覆盖，把 `baseUrl` 改成你的论坛并填入 `apiKey`（覆盖会整体替换 `config`，请把其它键一并写全）。
- 不需要 API Key 即可试用只读工具（默认指向 `https://meta.discourse.org`）。
- 密钥建议通过环境变量 `DISCOURSE_API_KEY` / `DISCOURSE_API_USERNAME` 提供，避免写进配置文件。
- 不需要写入权限时把 `readOnly` 设为 `true`，所有写操作会被插件直接拒绝。

## License

MIT © 2026 AkarinLiu. See [LICENSE](LICENSE).
