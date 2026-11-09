# dsh-plugin-discourse

[![npm](https://img.shields.io/npm/v/dsh-plugin-discourse.svg)](https://www.npmjs.com/package/dsh-plugin-discourse)
[![Publish to npm](https://github.com/AkarinLiu/dsh-plugin-discourse/actions/workflows/publish.yml/badge.svg)](https://github.com/AkarinLiu/dsh-plugin-discourse/actions/workflows/publish.yml)

Discourse administration and agent tools for the [DeepSeek Harness](https://github.com/deepseek-ai).

One Host plugin registers 17 model-facing tools over the Discourse REST API: an agent can search a
forum, read topics and profiles, publish posts, carry out the moderator and administrator work a
staff account would do in the web UI, and sign in through the user's browser with a scoped user API
key.

```
User → DSH agent → discourse_* tools → Discourse REST API → forum
```

## Tools

| Tool | Group | What it does | Key needed |
|---|---|---|---|
| `discourse_login` | auth | Start browser authorization, report the session, finish an older payload page, cancel a pending attempt, or sign out | no |
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
bundle list. Install it through the Web UI when you can: DSH's bundle installer replaces an existing
copy or local link before it writes the package, while the CLI is a thin pnpm wrapper.

**From the Web UI (recommended)** — open *Settings → Plugins → Install bundle* and enter
`dsh-plugin-discourse` for the npm package, or `github:AkarinLiu/dsh-plugin-discourse`, or a local
clone path. DSH installs the package, adds it to the profile's bundle list, and activates it.

**From npm on the CLI** — the launcher passes everything after `plugin` to pnpm, so this is a plain
pnpm install rather than the bundle installer:

```bash
dsh plugin --profile desktop add dsh-plugin-discourse
```

After a CLI install, select `dsh-plugin-discourse` once in the Plugins page (or through the
`plugin_manager` tool) so the profile records it as a bundle.

**From a clone** — `gh repo clone AkarinLiu/dsh-plugin-discourse`, then
`dsh plugin --profile desktop add ./dsh-plugin-discourse`. On Windows this creates a directory
junction in the profile; read the next section before moving that profile to the npm package.

To remove it, uninstall the bundle from the Plugins page, which drops the dependency and the bundle
entry together.

> The plugin is Host-only: no build step, no dependencies, no client assets.

### Windows: EPERM when replacing a local link

A clone install leaves `node_modules\dsh-plugin-discourse` as a directory junction. pnpm's hoisted
linker does not always record or prune that junction, so a later npm install cannot replace it and
Windows refuses the rename:

```text
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-plugin-discourse]
EPERM: operation not permitted, rename '...dsh-plugin-discourse_tmp_...' -> '...dsh-plugin-discourse'
```

The checkout is untouched; only the link is stale. From a clone of this repository, let the bundled
doctor remove the link and then reinstall:

```bash
node scripts/doctor.mjs --profile desktop --fix
dsh plugin --profile desktop add dsh-plugin-discourse
```

Or delete the junction by hand and retry:

```powershell
$link = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-discourse"
if ((Get-Item $link -Force -ErrorAction SilentlyContinue).LinkType -eq 'Junction') {
  (Get-Item $link -Force).Delete()
}
```

Restart the Harness after the package is replaced so the new module generation loads.

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
    authMode: auto
    loginScopes: read,write,session_info
    loginClientId: dsh-plugin-discourse
    loginApplicationName: DeepSeek Harness
    loginTimeoutMs: 600000
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
| `authMode` | `auto` | `auto` uses a stored browser session for normal calls and `apiKey` for staff/admin calls; `api-key` ignores the session; `user` requires it for every call. |
| `loginScopes` | `read,write,session_info` | Comma-separated scopes requested by browser sign-in. Narrow or extend this to match the forum's `allow_user_api_key_scopes`. |
| `loginClientId` | `dsh-plugin-discourse` | Client id Discourse records with the authorized key. |
| `loginApplicationName` | `DeepSeek Harness` | Application name shown on the forum authorization page. |
| `loginTimeoutMs` | `600000` | Browser sign-in deadline, 30000–1800000. Discourse's device code lives 10 minutes. |

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

### Browser sign-in

`discourse_login` obtains a **user API key** for the signed-in forum account, so the plugin can act as
that user without an admin key in the profile. On current Discourse releases it uses the device
authorization flow (`Auth API` version 4):

1. `discourse_login` with `action: "start"` returns a verification URL and an eight-character code.
2. Open the URL, sign in to the forum if needed, and confirm the code.
3. `discourse_login` with `action: "status"` reports the signed-in account.

The tool also accepts `waitSeconds` on `status` (0–120) when the caller wants to wait for the browser
step before reporting. `action: "cancel"` withdraws a pending attempt without touching a stored
session.

Forums older than the device flow get the classic `/user-api-key/new` page instead. The plugin asks
for the encrypted payload that page shows after approval, and
`discourse_login` with `action: "complete"` and the pasted `payload` finishes the sign-in. Neither
path needs an `auth_redirect`, a callback listener, or a change to
`allowed_user_api_auth_redirects`.

The authorized key is stored as the `discourse/session` record in the DSH credential store — never in
`cordis.patch.yml` and never in a tool result. `discourse_login` with `action: "logout"` revokes it at
the forum when possible and deletes the local record. `readOnly` still permits sign-in and sign-out:
they manage authentication, not forum content.

`authMode` decides which credential a request uses:

- `auto` (default) — normal reads and posts use the stored session; staff/admin tools keep using
  `apiKey` when one is configured, so moderation and administration still work.
- `api-key` — ignore any stored session and always use `apiKey`.
- `user` — require the stored session for every call; requests fail with a sign-in hint when it is
  missing or expired.

A user API key is limited to the account's own permissions and the scopes granted on the consent
page. It cannot call admin endpoints such as `/admin/users.json`; those tools need `apiKey` (or fail
with the forum's 403). A forum that does not allow `write` in `allow_user_api_key_scopes` needs
`loginScopes: read,session_info`.

## Safety

- `readOnly: true` blocks every content-mutating tool before any forum request is built. Browser
  sign-in and sign-out remain available because they manage the credential rather than content.
- `discourse_login` stores the user API key in the credential store and never prints it. Use
  `action: "logout"` to revoke it at the forum and remove the local record.
- `discourse_moderate_user` and the site-settings tools require an admin-scoped key; a key without
  those scopes receives the forum's 403 response, and the tool reports it instead of retrying. A
  browser session does not widen a user key into an admin key; `authMode: auto` therefore prefers a
  configured `apiKey` for staff and admin calls.
- Failures carry the HTTP status and Discourse's own error text, so a wrong id or a missing scope is
  visible in the transcript.
- Writes should be exercised with a staging forum first — `discourse_delete_post` with
  `permanent: true` is irreversible.

## Development

The package is plain ESM with no runtime dependencies; `index.js` is the whole plugin.

```bash
node --check index.js                          # syntax
npm test                                      # register every tool, validate definitions, and exercise browser login offline
node scripts/smoke.mjs --live                 # additionally call read-only tools against the forum
node scripts/login-test.mjs                   # browser login flow against a stubbed forum and credential store
npm run verify                                # build the npm tarball and check its file list
node scripts/doctor.mjs --profile desktop     # inspect a profile for a stale local link
```

`scripts/smoke.mjs` drives `apply()` with a stub context, so it exercises the real registration path
without starting a Harness. `scripts/login-test.mjs` drives the same `apply()` path with a stub
credential store, authorization seam, and forum: it starts the classic page, completes it with an RSA
payload, reads the status, and signs out, then repeats the device-code path. `scripts/verify-package.mjs`
packs the package with `npm pack` and fails when a runtime file is missing from `files`, when the
manifest loses `dsh.bundle`, or when a locale loses its display metadata. `prepack` runs the smoke and
login tests, so a broken package cannot be published.

## Release

Releases are automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml): every
push to `main` or a `v*` tag, and every pull request, verifies the package, and a `v*` tag publishes it to
[npmjs.com](https://www.npmjs.com/package/dsh-plugin-discourse) with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

1. Bump `version` in `package.json` (the tag must match it exactly).
2. Commit, then tag and push:

   ```bash
   git tag -a v1.1.0 -m "dsh-plugin-discourse 1.1.0"
   git push origin main --follow-tags
   ```

3. The workflow runs on Node 24, verifies the tarball, checks `v<version>`, and publishes with
   `--provenance --access public`.

Before the first release, add a **Trusted Publisher** on npmjs.com (package page → *Settings* →
*Trusted Publishing* → *GitHub Actions*):

| Field | Value |
|---|---|
| Repository | `AkarinLiu/dsh-plugin-discourse` |
| Workflow file | `publish.yml` |
| Environment | *(leave empty)* |
| Allowed action | `npm publish` |

No `NPM_TOKEN` secret is needed: the workflow exchanges the GitHub OIDC token
(`id-token: write`) for publish rights and attaches provenance. npm now requires an interactive 2FA
challenge for token and trusted-publisher management, so this one-time setup happens in the browser;
after it, tagged releases are fully automatic. The publish job logs the npm version, whether the OIDC
request URL reached it, and whether a `NPM_TOKEN` secret still exists, so a failed publish points at
its cause.

## 中文说明

- 这是一个 **Host 插件**，向 DSH 智能体提供 17 个 Discourse 工具（登录 / 读取 / 发帖 / 版主 / 管理员）。
- 浏览器授权登录：先调用 `discourse_login`（`action: "start"`），插件会返回论坛授权页地址和 8 位验证码；在浏览器中登录论坛并确认验证码后，再用 `action: "status"` 查看登录结果。中途放弃可用 `action: "cancel"`。新版 Discourse 使用设备授权码流程；旧版论坛会显示加密 payload，把该 payload 交给 `action: "complete"` 即可完成。两种方式都不需要配置 `auth_redirect`，也不需要修改 `allowed_user_api_auth_redirects`。
- 登录得到的用户 API Key 保存在 DSH 凭据存储的 `discourse/session` 记录中，不会写进 `cordis.patch.yml`，也不会出现在工具结果里；`action: "logout"` 会尽量在论坛撤销它并删除本地记录。
- `authMode: auto`（默认）下，普通读取和发帖使用已登录的会话，版主/管理员工具继续使用 `apiKey`；改为 `api-key` 可完全忽略会话，改为 `user` 则所有请求都必须先登录。
- 用户 API Key 只拥有该账号的权限，不能调用 `/admin/*` 管理接口；管理工具仍需 `apiKey`。如果论坛不允许 `write` scope，请把 `loginScopes` 调成 `read,session_info`。
- 安装：优先用 Web UI 的 *设置 → 插件 → 安装 bundle*，填入 `dsh-plugin-discourse`（npm）或 `github:AkarinLiu/dsh-plugin-discourse`；安装器会先替换旧的本地链接。
- 命令行：`dsh plugin --profile desktop add dsh-plugin-discourse` 只是把参数转交给 pnpm，安装后还需在插件页选中该 bundle。
- Windows 从本地克隆切到 npm 时报 `ERR_PNPM_EPERM ... rename ...dsh-plugin-discourse...`：这是 profile 里遗留的目录联接；运行 `node scripts/doctor.mjs --profile desktop --fix` 后再安装（脚本只删链接，不动源码），然后重启 Harness。
- 发布：推送 `v*` 标签会触发 `.github/workflows/publish.yml`。首次发布前在 npmjs.com 的包设置 → *Trusted Publishing* 添加 GitHub Actions（仓库 `AkarinLiu/dsh-plugin-discourse`、工作流 `publish.yml`、环境留空、允许 `npm publish`），之后不需要 `NPM_TOKEN`，由 OIDC 发布并生成 provenance。
- 配置：在 profile 的 `cordis.patch.yml` 中加一条 `id: discourse` 的覆盖，把 `baseUrl` 改成你的论坛并填入 `apiKey`（覆盖会整体替换 `config`，请把其它键一并写全）。
- 不需要 API Key 即可试用只读工具（默认指向 `https://meta.discourse.org`），也可以直接用浏览器登录获得用户会话。
- 密钥建议通过环境变量 `DISCOURSE_API_KEY` / `DISCOURSE_API_USERNAME` 提供，避免写进配置文件。
- 不需要写入权限时把 `readOnly` 设为 `true`，所有写操作会被插件直接拒绝；登录和退出仍可使用。

## License

MIT © 2026 AkarinLiu. See [LICENSE](LICENSE).
