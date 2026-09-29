# 架构说明

面向维护者：模块边界、数据流，以及几个"看起来绕但必须这样"的设计决策。
使用者请先读 [README](../README.md)。

## 1. 组成

```
profile: ${DSH_HOME:-~/.dsh}/profiles/<p>/cordis.patch.yml   ← 只写要覆盖的字段
        └── bundle: cordis.patch.yml (本包)         ← 只插入一行 `id: xxnerv-telegram`
                └── lib/index.js                    ← 宿主 half（装配点）
                      ├── lib/config.js             ← Schema 读取 / patch 构造 / 脱敏
                      ├── lib/telegram.js           ← Bot API 传输（直连 / CONNECT 隧道）
                      ├── lib/notify.js             ← turn/end 推送策略
                      └── bin/tg.mjs                ← 运维 CLI（脱离 agent loop）
        └── lib/client.js                           ← 浏览器 half（Plugins 配置表单）
```

| 文件 | 运行位置 | 职责 | 依赖 harness？ |
|---|---|---|---|
| [lib/index.js](../lib/index.js) | dsh 宿主进程 | 声明 Schemastery `Config`；注册 `xxnerv_telegram_send` / `xxnerv_telegram_config`；挂 `session/event` | 是（`tools`、`settings`、`logger`、`fiber`） |
| [lib/telegram.js](../lib/telegram.js) | 任意 Node | Bot API 请求：URL 组装、CONNECT 隧道、HTTP/1.1 交换与响应解析、超时/中止、错误映射 | 否 |
| [lib/config.js](../lib/config.js) | 任意 Node | 活引用读取、`xxnerv_telegram_config set` → patch、字段名、token 脱敏、chat id 归一化 | 否 |
| [lib/notify.js](../lib/notify.js) | 任意 Node | 提取该轮最后助手文本、合成推送正文、决定是否推送、并发去重 | 否 |
| [lib/client.js](../lib/client.js) | 浏览器 | 注册 `plugins.row.config` 配置表单，复用 `SettingsFormModel` 等基线组件 | 客户端运行时 |
| [bin/tg.mjs](../bin/tg.mjs) | 命令行 | `getMe` / `updates` / `send`，参数 + 环境变量回退 | 否（只 import `lib/telegram.js`） |

`inject: ['tools']` 保证工具注册前 registry 已就绪；配置项的运行时可变性由 `.volatile()` +
`.role('secret')` 表达，harness 因此把它们暴露为可编辑项，并把**活引用**交给插件。

## 2. 数据流

### 2.1 `xxnerv_telegram_send`（模型发起）

```
模型 → tools 注册表 → execute()
   ├─ current() 现读活配置（所以改了配置不用重载插件）
   ├─ chat_id ?? defaultChatId，空则报错并给出修法
   ├─ clampMessageText(text, 4096)
   ├─ callBotApi({ token, method: 'sendMessage', apiBase, proxyUrl, timeoutMs, signal })
   │     ├─ proxyUrl 为空 → https 直连 api.telegram.org
   │     └─ 有 proxyUrl  → net.connect 到代理 → 发 CONNECT → 升级 TLS → 自己写请求行
   └─ 返回 { summary, messageId, chatId, date, truncated }，模型只看到 summary
```

### 2.2 `turn/end` 自动推送（事件发起）

`ctx.on('session/event')` → 若 `notifyOnTurnEnd === true` → `TurnEndNotifier.observe(session, event)`：

- `user/message` 且 `source.kind === 'user'` 才把这个会话标记为"人发起过"（`notifyOnlyHumanSessions` 默认 `true`）。
- 跳过 `subagent/descriptor` 会话；`forked` / `interrupted` 这类合成结束事件静默。
- 推送正文：`🤖 DSH 任务完成 · <reason>` + 会话标题/id + 该轮最后的助手文本（`notifyMaxChars` 截断）。
- 同一会话的推送不重叠；目标 chat 为空且开关为真时，只告警一次，不刷屏。

### 2.3 `xxnerv_telegram_config set`（为什么返回"已提交"）

```
execute() → buildConfigPatch(args) → 无字段则报错
          → scheduleConfigWrite(ctx, ns, patch)
                ├─ ctx.get('settings') 不可用 → 明确告知改 profile patch
                ├─ 读 describe() 里的 revision 做 CAS 前置
                └─ setTimeout(0) → settings.update(ns, patch, revision)   ← 故意不 await
          → 立刻返回 ok/changed/effective；结果记入模块状态
```

`settings.update()` 会写 profile 的 `cordis.patch.yml` 再通过重载应用，而重载要等调用方让出；
await 它就会互等。因此写入是 fire-and-forget，`xxnerv_telegram_config status` 会带出
「最后一次写入」的结果供复核（`pending` / `ok` / `error`）。

写入目标 entry id 取自 `ctx.fiber.entry.options.id`（回退 `SETTINGS_NAMESPACE = 'xxnerv-telegram'`），
所以 profile 里把行重命名了也不会写错目标。

### 2.4 GUI 配置页（人发起）

`lib/client.js` 以 `plugins.row.config` 槽位、键 `dsh-xxnerv-telegram#xxnerv-telegram` 注册表单，
复用 `SettingsFormModel` / `SettingsForm` / `SettingsValueField` / `SettingsSecretField` 与
`Switch`。Host 从不回传已存的 token：已保存时控件显示一串 `*`（表示"已设置"而非空），
输入新值整体替换，留空保存表示保留原值；Save 才写入 profile，离开页面丢弃草稿。

## 3. 关键设计决策

| 决策 | 原因 |
|---|---|
| 自写 CONNECT 隧道（`node:net` + `node:tls`） | dsh 宿主是普通 Node，全局 `fetch` 不读 macOS 系统代理；引入 `undici`/`proxy-agent` 会破坏"零依赖、零全局副作用"的定位（不设 `NODE_USE_ENV_PROXY` 影响别的插件）。 |
| 隧道上自己做 HTTP/1.1 交换 | 已建立的 TLS socket 不满足 Node `Agent` 的连接状态机（`https.Agent` + `createConnection` 复用会挂住）；于是手写请求行、按 `content-length` / chunked 解析响应，`connection: close` 下每次请求一条隧道。 |
| `.volatile()` 而非重载生效 | 配置改动立即生效，用户不必重启应用；也避免"改配置 → 重载 → 中断当前轮"的体验问题。 |
| `botToken` 用 `.role('secret')` | 表单/API/工具输出只会看到"是否已设置"与掩码，明文不进入任何读取面。 |
| 配置写入不 await | 见 2.3：await 必然死锁（重载等调用方让出）。 |
| 浏览器 half 手写、无构建 | `dsh.client.platform: 'web'` + `exports["./client"]` 即可；手写 `__ModuleLoader__.load({ id, factory })`，只用基线模块，因此本包依旧零构建。 |
| 业务逻辑与 harness 解耦 | `telegram.js` / `config.js` / `notify.js` 不 import harness 模块，可用 `node:test` + 本地假服务器/假代理直接覆盖；harness 相关只做声明与接线。 |
| bundle patch 只插一行 | patch 会整块替换 `config`，让 Schema 默认值补全其余字段，profile 只需覆盖自己关心的键，升级时改动面最小。 |

## 4. 扩展点：加入站能力（Telegram → dsh）

目前**没有**这一层，唯一用到 `getUpdates` 的地方是 CLI 的 `updates` 子命令（`timeout: 0` 一次性拉取，
只为发现 chat id）。要加入站，需要新设计并明确以下取舍：

| 方案 | 要点 | 代价 |
|---|---|---|
| 长轮询 worker | `getUpdates(offset, timeout=25)` 循环 + offset 持久化；无公网要求 | 常驻连接、需要退避重连；**与 webhook 互斥** |
| `setWebhook` + HTTPS 端点 | 推送式、延迟低 | 需要公网可达或内网穿透 + 证书；也要处理重放与 401 |

无论哪种都必须：sender `chat_id` 白名单（否则任何拿到 bot 的人都可能驱动你的 agent）、
命令到 prompt 的映射与权限边界、以及与 CLI `updates` 的 offset 抢占关系（同一 bot 只有一个
`getUpdates` 消费者）。实现前先在 [CONTRIBUTING.md](../CONTRIBUTING.md) 第 7 节和
[CHANGELOG.md](../CHANGELOG.md) 里写下决定。

## 5. 测试边界

| 层次 | 命令 | 覆盖 |
|---|---|---|
| 单元 | `node --test test/*.test.mjs` | 直连 / CONNECT 隧道 / 代理鉴权 / 超时 / 错误映射 / 推送策略 / 配置读写 / 前端 half 装配渲染（用桩模块） |
| 集成 | `bash test/integration/run.sh` | 真实 dsh 运行时启动、bundle 层生效、插件挂载、`xxnerv_telegram_send` 走完工具流水线、`turn/end` 推送、`xxnerv_telegram_config set` 落盘 |
| UI | `bash test/ui/run.sh` | 无头 Chrome + CDP 打开真实客户端配置页、截图、保存回环，并断言展示用的 `*` 不会被写进 profile |
| 真实链路 | `LIVE=1 ... bash test/integration/run.sh tglive` | 真实 `api.telegram.org`（会真的发消息） |
| CI | [.github/workflows/ci.yml](../.github/workflows/ci.yml) | 单元测试（Node 22 / 24，零依赖，不需要 dsh） |

沙箱 profile 建在 `.scratch/` 下（`DSH_HOME` 指向它），不触碰真实 profile；集成测试用
`ELECTRON_RUN_AS_NODE=1` 调桌面版自带的 dsh CLI，因此验证的是与桌面版同一个运行时。
