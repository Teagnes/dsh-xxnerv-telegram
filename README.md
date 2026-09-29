# dsh-xxnerv-telegram

[![ci](https://github.com/Teagnes/dsh-xxnerv-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/Teagnes/dsh-xxnerv-telegram/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 Telegram 插件。它向 dsh 贡献四件事：

1. **`xxnerv_telegram_send` 工具** —— 模型可调用，把一条文本消息发到指定会话。
2. **`xxnerv_telegram_config` 工具** —— 查看/修改插件配置（token、目标 chat、代理、自动推送开关），写入 profile 后立即生效。
3. **Plugins 页面的配置表单** —— 侧边栏 **Plugins → `dsh-xxnerv-telegram` → `xxnerv-telegram` 行 → Configure**，token / chat id / 代理 / 推送开关都能在这里填并保存。
4. **轮次结束自动推送**（可选，默认关闭）—— 一个 turn 结束时，把该轮最后的助手文本推送到你的 Telegram。

插件零运行时依赖：网络层只用 Node 内置模块，并自带 HTTP `CONNECT` 代理支持（本机直连 `api.telegram.org` 不通时必需）。

## 文档索引

| 文档 | 内容 |
|---|---|
| 本文件 | 安装、配置、四种使用方式、验证与故障排查 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更与已知限制（Keep a Changelog 格式） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、硬约束（零依赖/零构建）、提交前自检清单 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块地图、数据流、关键设计决策、扩展点 |
| [AGENTS.md](AGENTS.md) | 给 AI agent 的仓库约定（与 CONTRIBUTING 同源，更精简） |
| [LICENSE](LICENSE) | MIT |
| [docs/screenshots](docs/screenshots) | Plugins 页面与配置页截图 |

## 安装

插件包就是一个 dsh **组合包**（bundle，`package.json` 里的 `dsh.bundle.patch` + `cordis.patch.yml` + 插件入口），安装即"把包加进 profile 依赖 + 把包名加进 `dsh.profile.bundles`"。

前置：`git`；dsh（桌面版或 CLI 均可）；Node ≥ 22 只在跑测试时需要（插件本身零依赖）。下面用 `Teagnes/dsh-xxnerv-telegram` 指代本仓库在 GitHub 上的位置，命令里的 `<profile>` 换成你的 profile 名（如 `web` / `tui` / `desktop`）。

### 方式 A：`dsh plugin`（任何非桌面 profile，推荐）

`dsh plugin --profile <name> <pnpm-args...>` 会把参数直接转给 profile 目录里的 pnpm，所以 pnpm 能装的 spec 都能用：

```sh
# 从 GitHub 安装（git 简写）
dsh plugin --profile <profile> add github:Teagnes/dsh-xxnerv-telegram

# 等价写法
dsh plugin --profile <profile> add git+https://github.com/Teagnes/dsh-xxnerv-telegram.git

# 也可以装 npm 包名，或指向本地克隆目录
dsh plugin --profile <profile> add dsh-xxnerv-telegram

# 升级
dsh plugin --profile <profile> update
```

从 git 安装时 pnpm 会执行 `prepare` 脚本；本包没有构建步骤，因此不会编译任何东西（源码即产物）。
dsh 生成的 profile 在 `pnpm-workspace.yaml` 里设了 `nodeLinker: hoisted` 与 `autoInstallPeers: false`，
所以 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 这两个 peer 依赖由 dsh 自身提供，不会被再装一份。

### 方式 B：桌面版（profile 由应用独占，必须走 GUI）

desktop profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。改用应用自带的 Plugins 页面：

1. 先把仓库克隆到本地：`git clone https://github.com/Teagnes/dsh-xxnerv-telegram.git`
2. 侧边栏 **Plugins → 从路径安装**，填入克隆出来的目录（GUI 支持**绝对路径**安装）。
3. 安装后该 bundle 会自动启用；应用会自己维护 profile 的 `package.json`、`pnpm-lock.yaml` 与 bundle 列表，
   后续升级（`git pull` 后重装）与卸载都在同一页面完成。

> 组合在启动时计算，**装完需要重启 dsh 桌面应用**才会生效。

### 方式 C：手工落地（GUI/CLI 都不方便时）

效果与上面等价，就是自己写好 profile 的依赖与 bundle 列表：

```sh
PLUGIN_DIR=/path/to/dsh-xxnerv-telegram                       # 克隆出来的目录
ln -s "$PLUGIN_DIR" "${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/node_modules/dsh-xxnerv-telegram"
```

`${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-xxnerv-telegram": "link:/path/to/dsh-xxnerv-telegram" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-xxnerv-telegram" ] } }
}
```

### 验证加载

```sh
# 组合里应出现 "# == dsh-xxnerv-telegram" 这一层和 id: xxnerv-telegram 那一行
dsh --profile <profile> --dump-config
```

desktop profile 由应用独占，CLI 连 `--dump-config` 都会拒绝；要验证就用一份逐字拷贝，或先用
`dsh <name> --from-default-profile <template>` 新建一个 profile。bundle 被跳过时会打印
`skipping profile bundle ...` 并给出原因（兼容性门禁不满足 / 找不到包）。


## 配置

配置项由插件 Schema 声明，取值来源是 profile 的 `cordis.patch.yml` 里 `id: xxnerv-telegram` 那一行；未写的字段由 Schema 默认值补齐，所以只写要改的键。

改配置有三种方式：

| 方式 | 说明 |
|---|---|
| **让 dsh 自己改**（推荐） | 直接说"把 Telegram token 改成 …／发到 @xxx／开启每轮推送"，模型调用 `xxnerv_telegram_config` 写入 profile，**立即生效，不用重启**。 |
| 编辑 `cordis.patch.yml` | 改 `id: xxnerv-telegram` 行后重启（或热重载）生效。 |
| **GUI Plugins 页面** | 侧边栏 **Plugins** → `dsh-xxnerv-telegram` → `xxnerv-telegram` 行 → **Configure**，表单里直接填并 **Save**。 |

带 **运行时可改** 的字段就是 `.volatile()` 字段：harness 会把它们作为可编辑配置项暴露出来，写入落在 profile patch 里，并且插件读到的是**活引用**——所以改完立刻生效。`botToken` 另外带 `role('secret')`，任何表单/API 面只会看到"是否已设置"，不会看到明文。

```yaml
- id: xxnerv-telegram
  name: "dsh-xxnerv-telegram"
  config:
    botToken: "123456789:AA..."      # @BotFather 给的 token
    defaultChatId: "@your_channel"   # 或数字 id（群组为负数）
    notifyChatId: "@your_channel"    # 不写则用 defaultChatId
    proxyUrl: "http://127.0.0.1:7897" # 直连不通时填本机代理
    notifyOnTurnEnd: false            # true = 每轮结束都推送；false（当前配置）= 只在你要求时由工具发送
```

| 字段 | 默认值 | 运行时可改 | 含义 |
|---|---|---|---|
| `botToken` | `''` | ✅（密钥，读取被脱敏） | Bot Token；为空时调用会报"未配置"并给出修法 |
| `defaultChatId` | `''` | ✅ | `xxnerv_telegram_send` 未传 `chat_id` 时的目标会话 |
| `notifyChatId` | `''` | ✅ | 推送目标；为空则回落到 `defaultChatId` |
| `proxyUrl` | `''` | ✅ | HTTP(S) `CONNECT` 代理，如 `http://127.0.0.1:7897`；留空为直连 |
| `notifyOnTurnEnd` | `false` | ✅ | 是否开启轮次结束自动推送 |
| `apiBase` | `https://api.telegram.org` | — | Bot API 基址，自建 Bot API server 或测试时可改 |
| `timeoutMs` | `15000` | — | 单次请求超时 |
| `notifyMaxChars` | `600` | — | 推送正文里助手文本的截断上限 |
| `notifyOnlyHumanSessions` | `true` | — | 只推送"人发起过"的会话，避免子代理/团队刷屏 |

配置落在 `${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/cordis.patch.yml` 的 `id: xxnerv-telegram` 行；本仓库自带的 `cordis.patch.yml` 只是 bundle 默认层，里面不写任何凭据。

## GUI 配置页

侧边栏 **Plugins** → `dsh-xxnerv-telegram` → `xxnerv-telegram` 行 → **Configure** 打开配置页（字段见上面的配置表，带 **运行时可改** 的都是表单字段）：

- **Bot token** —— 密码框，**只写不读**：Host 从不回传已存的 token。已保存时控件里显示一串 `*`（明确表示"已设置"，而不是空着让人以为没配），右侧另有「已设置 / 未设置」标签；直接输入新值会**整体替换**（`*` 不会被当成 token 存进去），留空保存表示保留原值。
- **Default chat / Notification chat / Proxy URL** —— 普通文本，显示生效值；被 profile 覆盖过会带 **已覆盖** 标签和 **恢复默认**。
- **Notify when a turn ends** —— 开关，同样支持恢复默认。
- **Save / 保存** 才写入；离开页面会丢弃未保存的草稿；写入落在 profile 的 `cordis.patch.yml`，保存后立即生效。

实现方式是插件自带的**浏览器 half**（[lib/client.js](lib/client.js)，包声明 `dsh.client` + `exports["./client"]`），注册到 Plugins 页面的 `plugins.row.config` 槽位（键 `dsh-xxnerv-telegram#xxnerv-telegram`），表单复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsFormModel` / `SettingsForm` / `SettingsValueField` / `SettingsSecretField`。它是手写的、无需构建步骤，因此本包依旧零构建、零运行时依赖。

> 首次让配置页出现：插件已经在跑的 dsh 里加载过宿主部分，而客户端的 `dsh.client` 扫描发生在启动/条目变化时。**把插件在 Plugins 页面关掉再打开，或重启应用**，Configure 就会出现。

## 使用

**当前 desktop profile 的状态：只在你明确要求时发送。** 每轮自动推送是关闭的（`notifyOnTurnEnd: false`），只有模型工具 `xxnerv_telegram_send` 会发消息，而它只在你说"发到 Telegram / 通知我"时才会被调用。想恢复自动推送就把该字段改成 `true`。

### 模型工具 `xxnerv_telegram_send`

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 消息正文，超过 4096 字符会截断 |
| `chat_id` | 否 | 目标会话；省略则用 `defaultChatId` |
| `parse_mode` | 否 | `HTML` 或 `MarkdownV2`；不传为纯文本（不会因标记非法而失败） |
| `silent` | 否 | 静默发送（`disable_notification`） |

返回 `messageId` / `chatId` / `date` / `truncated`，模型看到一行摘要。

直接对 dsh 说"把结果发到 Telegram"即可触发。工具描述里明确要求**只在用户要求时发送**，避免模型自行打扰。

### 模型工具 `xxnerv_telegram_config`

`action: 'status'` 报告当前生效配置（token 只显示前后几位）；`action: 'set'` 写入指定字段：

| 参数 | 说明 |
|---|---|
| `action` | `status` 或 `set`（必填） |
| `bot_token` | 新的 Bot Token（只写不读，工具输出里不会回显） |
| `default_chat_id` | 默认目标会话，如 `@your_channel` 或 `-1001234567890` |
| `notify_chat_id` | 自动推送的目标；留空回落到 `default_chat_id` |
| `proxy_url` | 代理地址，如 `http://127.0.0.1:7897`；留空为直连 |
| `notify_on_turn_end` | 是否开启每轮自动推送 |

直接说"把 Telegram token 改成 xxx"、"以后发到 @yyy"、"关掉每轮推送"即可。写入经 harness 配置服务落到 profile 的 `cordis.patch.yml`，**下一轮调用时已生效**；`status` 会显示"最后一次写入"的结果。

> 为什么 set 返回的是"已提交"而不是"已成功"：配置服务写完文件后要等这一轮调用结束才应用（应用过程本身在等调用让出），所以工具不能在同一轮里等它完成。写入是真落盘的，`status` 复核一次即可看到新值。

### 自动推送（当前关闭）

开启 `notifyOnTurnEnd` 后，`turn/end` 会推送：

```
🤖 DSH 任务完成 · completed
会话：<会话标题或 id>
————
<该轮最后的助手文本，按 notifyMaxChars 截断>
```

规则：只推送**人发起过**的会话（`user/message` 的 `source.kind === 'user'`），跳过子代理会话（`subagent/descriptor`），跳过 `forked` / `interrupted` 这类崩溃修复产生的合成结束事件，同一会话的推送不重叠。

### 运维 CLI

装到 profile 后命令名是 `dsh-xxnerv-telegram`；不安装、直接跑仓库源码时用 `node bin/tg.mjs`，两者参数一致：

```sh
dsh-xxnerv-telegram getMe   --token <t> [--proxy <url>]
dsh-xxnerv-telegram updates --token <t> [--proxy <url>] [--limit 20]   # 找出 chat id
dsh-xxnerv-telegram send    --token <t> --chat @chan --text "hello"

# 等价的源码调用
node bin/tg.mjs getMe --token <t>
```

环境变量回退：`DSH_XXNERV_TELEGRAM_BOT_TOKEN`、`DSH_XXNERV_TELEGRAM_PROXY`、`DSH_XXNERV_TELEGRAM_API_BASE`。

## 测试

```sh
# 单元测试：HTTP 直连 / CONNECT 代理隧道 / 代理鉴权 / 超时 / 错误映射 / 推送策略
node --test test/*.test.mjs

# 集成测试：真实 dsh 运行时启动 + 插件挂载 + 工具流水线 + 轮次结束推送 + 配置写入
bash test/integration/run.sh

# 只发工具、不发推送（断言零推送请求）
NOTIFY_ON_TURN_END=false bash test/integration/run.sh tgtoolonly

# UI 渲染 + 保存回环：无头 Chrome 打开真实客户端，点进 Plugins → 插件 → telegram 行 → Configure，
# 截图到 .scratch/ui-verify/shots/，并断言登录后页面里出现四个输入框
bash test/ui/run.sh

# 同上，并额外在 GUI 里改「默认会话」后点保存，断言 profile patch 被写入
UI_SAVE_VALUE=@gui_test bash test/ui/run.sh

# 真实链路：走真实 api.telegram.org，会真的发消息
LIVE=1 DSH_XXNERV_TELEGRAM_BOT_TOKEN=... DSH_XXNERV_TELEGRAM_CHAT_ID=@chan \
  DSH_XXNERV_TELEGRAM_PROXY=http://127.0.0.1:7897 bash test/integration/run.sh tglive
```

集成 / UI 测试自建沙箱 profile（`DSH_HOME` 指向 `.scratch/` 下的目录），**不会碰你真实的 profile**；两者都需要本机装有 dsh 桌面版与 Chrome，默认路径可用环境变量覆盖：

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_APP` | `/Applications/DeepSeek Harness.app` | 桌面版安装位置 |
| `DSH_NODE` | `$HOME/.dsh/dsh-runtimes/.../node/bin/node` | Node ≥ 22 |
| `CHROME` | `/Applications/Google Chrome.app/.../Google Chrome` | UI 测试用的无头浏览器 |
| `DSH_DESKTOP_PATCH` | `$HOME/.dsh/profiles/desktop/cordis.patch.yml` | UI 测试复刻界面时读取的 profile UI 行 |

集成测试用 `ELECTRON_RUN_AS_NODE=1` 调用安装版自带的 dsh CLI，因此验证的是**与桌面版同一个运行时**。单元测试不需要 dsh，CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 Node 22 / 24 上只跑单元测试。

已验证结论（安装版 0.1.7-rc.2）：

- 单元 62 项全通过（Telegram 客户端、代理隧道、推送策略、配置读写，以及用桩模块加载浏览器 half 的装配/渲染冒烟测试）。
- 集成测试三种形态均通过：`notifyOnTurnEnd: true`（工具 + 推送 + 配置写入 = 3 个请求）、`false`（工具 + 配置写入 = 2 个请求，零推送）、LIVE（真实 Telegram）。
- `xxnerv_telegram_config set` 端到端验证：写入后 profile patch 更新、生效值变为新 chat、随后的 `xxnerv_telegram_send` 实际发到新 chat（LIVE 下真实送达）；写入不会丢掉 `botToken` / `apiBase` 等未涉及的字段。
- desktop profile 的逐字拷贝 `--dump-config` 显示组合层与配置正确，无兼容性跳过。
- GUI 配置页端到端验证（无头 Chrome + CDP，`test/ui/run.sh`）：真实客户端里 Plugins → `dsh-xxnerv-telegram` → `xxnerv-telegram` 行 → **Configure** 打开配置页，渲染出 `xxnerv-telegram-botToken`（password，已保存时显示 `****************`）、`xxnerv-telegram-defaultChatId`、`xxnerv-telegram-notifyChatId`、`xxnerv-telegram-proxyUrl` 四个输入框与「每轮结束推送」开关、保存按钮；在页面里把 token 与默认会话改成新值并点保存后，沙箱 profile 的 `cordis.patch.yml` 变为 `botToken: 1100000000:AAF-GUI-CHECK` 与 `defaultChatId: "@gui_test"`，并断言显示用的 `*` 没有被写进 profile。截图见 [docs/screenshots](docs/screenshots)。
- GUI 前端 half 客观验证：沙箱内以 `base + web-app + 本插件` 启动 web 实例，页面注入的 `window.__DSH_BOOT__` 含 `{"id":"dsh-xxnerv-telegram","url":"plugins/??dsh-xxnerv-telegram/client.js&rev=…"}`，且该 combo URL 返回 200 并包含 `plugins.row.config` / `dsh-xxnerv-telegram#xxnerv-telegram` 注册内容，宿主启动无 client-modules 报错（页面渲染效果需你在 GUI 里确认）。

## 如何验证

三层，从最省事到最彻底。

### 1. 在 GUI 里点一遍（约 1 分钟）

1. 让客户端 half 被扫描到：Plugins 页面把 `dsh-xxnerv-telegram` **关掉再打开**，或重启应用。
2. **Plugins → `dsh-xxnerv-telegram` → `xxnerv-telegram` 行 → Configure**。应看到 Bot Token（密码框，右侧「已设置」）、默认会话（`@your_channel`）、通知会话、代理地址（`http://127.0.0.1:7897`）、「每轮结束推送」开关、底部 **保存**。
3. 改「默认会话」但**不保存**，离开页面再回来 → 恢复原值（草稿会丢弃）。
4. 改一个值 → **保存** → 让我复核（对 dsh 说"看 Telegram 配置状态"即可，走 `xxnerv_telegram_config status`），或直接看 `${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/cordis.patch.yml` 里 `id: xxnerv-telegram` 那行。

参考截图：[配置页](docs/screenshots/3-telegram-config.png) · [插件卡片与 Configure](docs/screenshots/2-plugin-card.png) · [保存后](docs/screenshots/5-after-save.png)

### 2. 一条命令复跑自动化

| 检查 | 命令 |
|---|---|
| 单元测试（62 项：客户端、代理隧道、推送策略、配置、前端 half 装配） | `node --test test/*.test.mjs` |
| 集成：真实 dsh 运行时 + 工具 + 推送 + 配置写入（本地假 Telegram） | `bash test/integration/run.sh` |
| 集成：只发工具、零推送（当前 desktop 形态） | `NOTIFY_ON_TURN_END=false bash test/integration/run.sh` |
| **UI**：无头 Chrome 渲染配置页 + 截图 + 保存回环（含 token 掩码不被写入的断言） | `UI_SAVE_VALUE=@gui_test bash test/ui/run.sh` · token 也验：`UI_SAVE_TOKEN='123:ABC' bash test/ui/run.sh` |
| 真实 Telegram：真发消息 | `LIVE=1 DSH_XXNERV_TELEGRAM_BOT_TOKEN=… DSH_XXNERV_TELEGRAM_CHAT_ID=@chan DSH_XXNERV_TELEGRAM_PROXY=http://127.0.0.1:7897 bash test/integration/run.sh tglive` |

`test/ui/run.sh` 会在沙箱里起一个 web 实例（base + web-app + 本插件 + 你的 desktop UI patch 行），用 Chrome DevTools Protocol 点进配置页并截图，全程不碰你的真实 profile。

### 3. 端到端闭环（最彻底）

在配置页把默认会话改成另一个 chat 并保存 → 对我说"把测试消息发到 Telegram" → 看 Telegram 是否到达**新**会话。这一条同时验证了 GUI 写入、配置热生效与发送链路。

## 故障排查

| 现象 | 原因与修法 |
|---|---|
| `telegram request timed out ... set the plugin's proxyUrl` | 本机直连不通 Telegram，填 `proxyUrl`（本机系统代理是 `http://127.0.0.1:7897`） |
| `telegram getMe failed (HTTP 401): Unauthorized` | token 错或已失效 |
| `Bad Request: chat not found` | chat id / 用户名错，或 bot 不在该群/频道里（频道需把 bot 设为管理员） |
| 工具报 `xxnerv_telegram_send has no target chat` | 调用没给 `chat_id`，且配置没有 `defaultChatId` |
| 重启后插件没出现 | 组合在启动时计算：确认 bundle 已在 `dsh.profile.bundles`、软链存在、`--dump-config` 里有该层；被跳过时会打印 `skipping profile bundle ...` 原因 |
| 升级 dsh 后被跳过 | 兼容性门禁：`peerDependencies` 的 `@deepseek-ai/dsh-tools` 范围不满足时会跳过并提示，按提示用 `dsh plugin --profile <p> allow-version ...` 授权 |
| Plugins 页面看不到 **Configure** | 客户端 `dsh.client` 扫描发生在启动/条目变化时：把插件在 Plugins 页面关掉再打开，或重启应用 |
| 配置页是只读的 / 保存无效 | 该部署的 settings 持久化对当前页面不可写（例如非 loopback 访问），改用 `xxnerv_telegram_config` 工具或直接编辑 patch |
| `xxnerv_telegram_config` 报 settings 服务不可用 | 该 profile 没有挂载 `@deepseek-ai/dsh-settings`（base 组合包提供）；此时直接编辑 profile 的 `cordis.patch.yml` |
| 写入显示"已提交"但 `status` 还是旧值 | 应用要等当前调用结束；稍后再 `status` 一次，或看 `status` 里的"最后一次写入"结果 |
| 推送太吵 | `notifyOnlyHumanSessions: true`（默认）已排除子代理/团队会话；如仍嫌多，关掉 `notifyOnTurnEnd` 或把 `notifyChatId` 指向单独频道 |

## 卸载 / 回滚

```sh
# 非桌面 profile：从依赖里移除（同时会更新 bundle 列表）
dsh plugin --profile <profile> remove dsh-xxnerv-telegram
```

桌面上装的版本直接在 **Plugins** 页面卸载；手工软链落地的情况（方式 C）自己回退：

```sh
rm "${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/node_modules/dsh-xxnerv-telegram"   # 软链
# 再从 package.json 的 dependencies 与 dsh.profile.bundles 里删掉包名
# 并从 cordis.patch.yml 删掉 id: xxnerv-telegram 那一行
```


## 实现说明

- **紧凑的 bundle 形态**：`cordis.patch.yml` 只插入一行 `id: xxnerv-telegram`；其余交给 Schemastery Schema 的默认值，profile 只覆盖自己关心的键（patch 会整块替换 `config`，schema 默认值补全其余）。
- **自带 CONNECT 隧道**：dsh 宿主跑在 Node 上，全局 `fetch` 不读 macOS 系统代理，所以在 `lib/telegram.js` 里用 `node:net` + `node:tls` 实现了代理隧道，不引入依赖、不改全局状态（例如不设置 `NODE_USE_ENV_PROXY` 影响别的插件）。
- **隧道上直接做 HTTP/1.1 交换**：已建立的 TLS socket 不满足 Node `Agent` 的连接状态机（`https.Agent` + `createConnection` 复用会挂住），因此自己写请求行、按 `content-length` / chunked 解析响应；`connection: close` 下每次请求一条隧道。
- **配置项而非硬编码**：可运行时修改的字段用 `.volatile()` 声明，插件读到的是活引用，因此改配置无需重载插件；`botToken` 额外用 `role('secret')`，表单/API 只能看到"是否已设置"。插件自己的配置行 id 通过 `ctx.fiber.entry.options.id` 发现，重命名行也不会写错目标。
- **写入为什么不能 await**：`ctx.settings.update()` 会写 profile patch 再通过重载应用；重载要等调用方让出，await 它就会互等。所以 `xxnerv_telegram_config set` 同步发起写入、立刻返回，把结果记在插件状态里供 `status` 复核（已用探针实测：直接发起与定时器发起两种方式都能落地生效）。
- **前端 half 无需构建**：客户端 bundle 直接手写成宿主投递要求的 `window.__ModuleLoader__.load({ id, factory })` 形式，只用基线模块（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`），因此不引入打包器；`dsh.client.platform: 'web'` + `exports["./client"]` 就是全部声明。
- **可测试性**：能脱离 harness 的逻辑（客户端、推送策略、配置读写）放在 `lib/telegram.js`、`lib/notify.js`、`lib/config.js`，用 `node:test` 加本地假服务器/假代理覆盖；harness 相关部分只做声明与接线，由集成测试验证。

更细的模块边界、数据流与"为什么必须这样写"见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 项目结构

```
.
├── package.json          # 包元数据 + dsh.bundle.patch / dsh.client 声明（零依赖、零构建）
├── cordis.patch.yml      # bundle 层：只插入一行 `id: xxnerv-telegram`
├── lib/
│   ├── index.js          # 宿主 half：Schema、两个工具、turn/end 接线
│   ├── telegram.js       # Bot API 传输：直连 / HTTP CONNECT 隧道 / 超时 / 错误映射
│   ├── config.js         # 活配置读取、patch 构造、token 脱敏
│   ├── notify.js         # 轮次结束推送策略
│   └── client.js         # 浏览器 half：Plugins 页配置表单（手写，无构建）
├── bin/tg.mjs            # 运维 CLI：getMe / updates / send
├── test/
│   ├── *.test.mjs        # 单元测试（node:test）
│   ├── integration/      # 真实 dsh 运行时 + 本地假 Telegram
│   └── ui/               # 无头 Chrome 渲染配置页 + 保存回环
├── docs/
│   ├── ARCHITECTURE.md   # 架构与设计决策
│   └── screenshots/      # Plugins 页面与配置页截图
├── .github/workflows/ci.yml   # CI：Node 22 / 24 上跑单元测试
├── README.md · CHANGELOG.md · CONTRIBUTING.md · AGENTS.md · LICENSE
└── .scratch/             # 测试沙箱与 profile 备份（本机产物，已 gitignore）
```

## 参与开发

改代码前请读 [CONTRIBUTING.md](CONTRIBUTING.md)（硬约束、命令、提交前自检清单）；
用 AI agent 改的话看更精简的 [AGENTS.md](AGENTS.md)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

`.gitignore` 已排除 `.scratch/`（测试沙箱与 profile 备份）。提交前请确认没有把真实
token / chat id 或含凭据的 profile patch 带进仓库——本仓库自带的 `cordis.patch.yml` 只有一行 `id: xxnerv-telegram`，
凭据一律留在 `${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/cordis.patch.yml` 里。

## 许可证

[MIT](LICENSE) © 2026 dsh-xxnerv-telegram contributors。

