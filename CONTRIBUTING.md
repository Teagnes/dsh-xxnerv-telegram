# 参与开发

感谢你愿意改这个插件。它很小（约 1470 行 JS + 测试），但有几条**硬约束**是先于便利性的，
请先读完本节再动手。

## 1. 硬约束

1. **零运行时依赖**：源码里不允许出现除 `node:*` 以外的新 `import`（`lib/` 只 import 内置模块与
   同目录文件；`lib/index.js`、`lib/client.js` 另可用 `@deepseek-ai/*` 的 peer 模块）。
2. **零构建步骤**：没有打包器、没有编译产物。浏览器 half 手写成宿主投递要求的
   `window.__ModuleLoader__.load({ id, factory })` 形式，只使用基线模块（`react`、`react/jsx-runtime`、
   `@deepseek-ai/dsh-client-ui-primitives`）。不要引入 TS/JSX 源码或 `dist/`。改完直接可跑。
3. **密钥只写不读**：`botToken` 必须保持 `.role('secret')`，任何输出路径都要过 `maskSecret()`
   （`lib/config.js`）。测试里断言"明文 token 不出现在工具输出 / 表单 / profile 的显示值里"。
4. **不要把 `ctx.settings.update()` 变成 `await`**：配置服务写完文件后要靠重载生效，而重载要等调用方
   让出；await 它必然互等（死锁）。现有实现是 `setTimeout(..., 0)` fire-and-forget + 把结果记进
   模块状态供 `status` 复核（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 3 节）。
5. **网络层只用 Node 内置模块**：新增传输方式（例如 SOCKS 代理）时，同时更新
   [lib/telegram.js](lib/telegram.js) 与 README 的「远程调用」一节，并补单测。
6. **保持可脱离 harness 测试**：`lib/telegram.js`、`lib/config.js`、`lib/notify.js` 不得 import
   harness 模块，纯函数尽量导出以便直接测；harness 相关只允许出现在 `lib/index.js` 与 `lib/client.js`。

## 2. 环境

- Node **≥ 22**（`package.json` 的 `engines`）。单测只需要这个，CI 在 Node 22 / 24 上跑。
  桌面版自带的运行时也能用（默认 `$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`，
  用 `DSH_NODE` 覆盖）。
- 无需 `npm install`：仓库没有依赖。装进 dsh 的方式见 README「安装」。

## 3. 常用命令

```sh
# 单元测试（传输 / 代理隧道 / 推送策略 / 配置 / 前端 half 装配）
node --test test/*.test.mjs

# 集成测试：真实 dsh 运行时启动 + 插件挂载 + 工具流水线 + 轮次推送 + 配置写入（本地假 Telegram）
bash test/integration/run.sh

# 只发工具、零推送
NOTIFY_ON_TURN_END=false bash test/integration/run.sh tgtoolonly

# UI 回环：无头 Chrome 打开真实客户端 → Plugins → Configure → 截图 + 保存断言
bash test/ui/run.sh
UI_SAVE_VALUE=@gui_test bash test/ui/run.sh
# 额外探针：打开「添加插件」对话框并打印其输入控件（核对 README 的安装说明）
UI_PROBE_ADD_PLUGIN=1 bash test/ui/run.sh

# 真实链路（会真的发消息，需要 token）
LIVE=1 DSH_XXNERV_TELEGRAM_BOT_TOKEN=... DSH_XXNERV_TELEGRAM_CHAT_ID=@chan \
  DSH_XXNERV_TELEGRAM_PROXY=http://127.0.0.1:7897 bash test/integration/run.sh tglive
```

集成 / UI 测试都在 `.scratch/` 下自建沙箱 profile（`DSH_HOME` 指向沙箱），**不会碰你真实的
profile**。它们需要本机装有 dsh 桌面版与 Chrome，默认路径都能覆盖：`DSH_APP`（桌面版位置）、
`DSH_NODE`（Node ≥ 22）、`CHROME`（无头浏览器）、`DSH_DESKTOP_PATCH`（UI 测试复刻界面时读取的
desktop profile patch）。没有桌面版的环境只能跑单元测试——CI 就是这种形态。

验证 profile 组合是否正确：

```sh
NODE="${DSH_NODE:-$(command -v node)}"
DSH_HOME=... "$NODE" "$DSH_APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile <name> --dump-config    # 应出现 "# == dsh-xxnerv-telegram" 层与 telegram 行
```

用 `dsh` CLI 直接跑更简单：`dsh --profile <name> --dump-config`。

> desktop profile 由 Electron 应用独占管理，CLI 连 `--dump-config` 都会拒绝；请用逐字拷贝的 profile 验证。

## 4. 代码约定

- ESM + 2 空格缩进，**无分号风格**与现有文件一致。
- 每个导出函数/类都要有 JSDoc（`@param` / `@returns` / `@throws`），错误用 `TelegramError`
  并带上 `method` / `status` / `description`，方便 README 的故障排查表对照。
- 新增配置字段时：运行时由人修改的字段加 `.volatile()`；密钥加 `.role('secret')`；
  在 `package.json` 与 README 的配置表里同步说明，并判断是否需要 CLI / 工具 / 表单三处打通
  （`lib/config.js` 的 `buildConfigPatch` 是 `xxnerv_telegram_config set` 的唯一入口）。
- 中文用于面向用户的文案（工具描述、README、表单标签），英文用于代码与注释。

## 5. 提交前的自检清单

- [ ] `node --test test/*.test.mjs` 全绿（当前 62 项）。
- [ ] 改了宿主逻辑：跑 `bash test/integration/run.sh`；改了推送策略：再跑一次 `NOTIFY_ON_TURN_END=false` 形态。
- [ ] 改了 `lib/client.js` 或表单字段：跑 `bash test/ui/run.sh`（必要时带 `UI_SAVE_VALUE`）。
- [ ] 改了对外行为、配置项、命令或限制：同步 README 与 [CHANGELOG.md](CHANGELOG.md)（"Unreleased" 段落）。
- [ ] 没有把真实 token / chat id / 本机 profile 内容写进仓库文件（`.gitignore` 已排除 `.scratch/`）。
- [ ] `package.json` 的 `peerDependencies` 范围仍然覆盖你验证时用的 dsh 版本；不覆盖就要按提示
      用 `dsh plugin --profile <p> allow-version ...` 授权，并在 CHANGELOG 里说明。

## 6. 版本与发布

- 语义化版本；破坏性变更（改工具参数、改配置字段语义、改 profile 行 id）走主版本。
- 发布前更新 `CHANGELOG.md`（把 "Unreleased" 提为版本号 + 日期），并确认 `files` 白名单包含
  你新增的文档（`files` 之外的文件不会被 npm 打包）。
- 兼容性门禁：`peerDependencies` 不满足时 dsh 会跳过该 bundle 并打印
  `skipping profile bundle ...`；这是**预期行为**，不要为了让门禁通过而放宽范围。

## 7. 安全

- 这个插件目前**只有出站方向**：没有 webhook、没有长轮询循环、没有命令分发。
  因此不存在入站攻击面，也没有"远程用 Telegram 驱动 dsh"的能力。
- 若要加入站能力，请先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 4 节：必须设计
  sender `chat_id` 白名单、避免 `getUpdates` 与 webhook 冲突，并明确谁能触发什么。
