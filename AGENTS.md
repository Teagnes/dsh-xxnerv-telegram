# AGENTS.md — dsh-xxnerv-telegram

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 Telegram 插件：
`xxnerv_telegram_send` / `xxnerv_telegram_config` 两个模型工具、轮次结束自动推送、Plugins 页面配置表单、
以及一个脱离 agent loop 的运维 CLI。宿主 half 是 [lib/index.js](lib/index.js)，浏览器 half 是
[lib/client.js](lib/client.js)。

面向用户的完整说明在 [README.md](README.md)；模块与设计决策见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；改代码前先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 硬约束（改动前必须遵守）

1. **不加运行时依赖、不加构建步骤**：`lib/` 只 import `node:*` 与同目录文件；无打包器、无 `dist/`。
2. **密钥只写不读**：`botToken` 保持 `.role('secret')`，一切输出过 `maskSecret()`；不要在文档、
   测试或提交里放真实 token / chat id。
3. **不要 `await ctx.settings.update()`**：配置重载要等调用方让出，await 会死锁；现有实现是
   `setTimeout(0)` fire-and-forget + 结果记入状态供 `xxnerv_telegram_config status` 复核。
4. **不要引入入站能力**（webhook / `getUpdates` 长轮询 / 命令分发）而不先设计
   sender `chat_id` 白名单；当前插件是纯出站，这是有意的安全边界。
5. **测试边界不破**：`lib/telegram.js`、`lib/config.js`、`lib/notify.js` 不得 import harness 模块，
   以便 `node:test` 直接覆盖。

## 常用命令

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node   # Node ≥ 22（DSH 自带运行时），无需 npm install

$NODE --test test/*.test.mjs                 # 单元测试（当前 62 项）
bash test/integration/run.sh                 # 集成：真实 dsh 运行时 + 工具 + 推送 + 配置写入（本地假 Telegram）
NOTIFY_ON_TURN_END=false bash test/integration/run.sh   # 只发工具、零推送
bash test/ui/run.sh                          # 无头 Chrome 渲染配置页 + 保存回环
UI_SAVE_VALUE=@gui_test bash test/ui/run.sh  # 同上，并断言 profile patch 被写入
LIVE=1 DSH_XXNERV_TELEGRAM_BOT_TOKEN=... DSH_XXNERV_TELEGRAM_CHAT_ID=@chan \
  DSH_XXNERV_TELEGRAM_PROXY=http://127.0.0.1:7897 bash test/integration/run.sh tglive
```

沙箱 profile 建在 `.scratch/`（已在 `.gitignore` 里），不会碰你真实的 profile。集成 / UI 测试需要
本机装有 dsh 桌面版与 Chrome，默认路径可用 `DSH_APP` / `DSH_NODE` / `CHROME` / `DSH_DESKTOP_PATCH`
覆盖；单元测试不需要 dsh，CI（`.github/workflows/ci.yml`）在 Node 22 / 24 上只跑它。

## 改动后自检

- 改了宿主逻辑 → 跑单元 + `test/integration/run.sh`；改了 `lib/client.js` → 跑 `test/ui/run.sh`。
- 改了对外行为、配置字段、命令或限制 → 同步 README 与 [CHANGELOG.md](CHANGELOG.md) 的 "Unreleased"。
- 改了配置字段 → 检查 `lib/index.js` 的 Schema、`lib/config.js` 的 `buildConfigPatch`、README 配置表、
  `lib/client.js` 表单四处是否一致（`buildConfigPatch` 是 `xxnerv_telegram_config set` 的唯一入口）。
- 改完读一遍 diff：不要顺手改 `package.json` 的 `name` / `bin` / `cordis.patch.yml` 的行 id——
  已安装的 profile 通过软链与行 id 引用它们，改了会断掉现有安装。
