# 变更日志

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **项目改名为 `dsh-xxnerv-telegram`**，与官方插件彻底隔离，改到的标识一次列清：
  包名（`package.json` 的 `name`）、CLI（`bin` 从 `dsh-telegram` 改为 `dsh-xxnerv-telegram`）、
  bundle 行 id（`telegram` → `xxnerv-telegram`，全 profile 唯一）、settings 命名空间
  （`settings.telegram` → `settings.xxnerv-telegram`）、插件 `name` 导出、客户端槽位键
  （`dsh-xxnerv-telegram#xxnerv-telegram`）与表单 DOM id（`xxnerv-telegram-*`）、
  模型工具名（`telegram_send` / `telegram_config` → `xxnerv_telegram_send` / `xxnerv_telegram_config`）、
  环境变量（`DSH_TELEGRAM_*` → `DSH_XXNERV_TELEGRAM_*`；顺带去掉 CLI 里 `TELEGRAM_BOT_TOKEN` 这个
  通用回退名）。0.1.0 条目已按最终命名改写——该版本尚未对外发布，改名发生在首次发布之前。
  升级提示：已安装的 profile 需同步改软链名、依赖键、`dsh.profile.bundles` 条目与配置行的
  `id` / `name`（配置内容不变），然后重启 dsh。
- 安装说明改为以已发布的仓库地址为基准（<https://github.com/Teagnes/dsh-xxnerv-telegram>）：把安装源整理成
  GitHub 简写 / tag 锁定 / 完整 URL / SSH / 本地目录 / npm 包名六种规范写法，补「升级」对照表；桌面版的
  GUI 流程按实测的「添加插件 → 包名或地址」对话框重写（该框接受包名、GitHub 仓库地址或本地目录路径）。
  文档中不再出现作者本机的绝对路径或用户专属凭据。
- UI 测试新增 `UI_PROBE_ADD_PLUGIN=1` 探针：打开「添加插件」对话框并记录其输入控件，用于核对安装说明
  与实际界面一致（默认关闭，不影响常规断言）。
- 集成测试的 probe overlay 改为运行期生成（此前 `test/integration/probe.patch.yml` 硬编码了作者的
  绝对路径，clone 后必然失败）；该文件已删除。
- UI 测试脚本的沙箱 fixture 由真实频道改为 `@your_channel`，并新增 `DSH_DESKTOP_PATCH` 覆盖项
  （此前固定读取 `$HOME/.dsh/profiles/desktop/cordis.patch.yml`）；`docs/screenshots` 已按脱敏数据重拍。
- 单元测试里的真实 bot token 与 bot id 替换为合成 fixture；`maskSecret` 断言改为对 fixture 的
  前缀/后缀与中段不泄漏做断言。
- UI 截图脚本新增叠加弹窗清理（首启 API Key 对话框 + 「预览版说明」通知会互相叠加、遮住页面），
  循环点掉后再截图；`docs/screenshots` 已重拍为无遮挡画面。

### 新增

- 项目级文档：[CONTRIBUTING.md](CONTRIBUTING.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、
  [AGENTS.md](AGENTS.md)、[CHANGELOG.md](CHANGELOG.md)、[LICENSE](LICENSE)（MIT）、`.gitignore`。
- GitHub Actions 单测流水线：Node 22 / 24 上跑 `node --test test/*.test.mjs`（零依赖，秒级完成）。
- 仓库发布到 GitHub：[Teagnes/dsh-xxnerv-telegram](https://github.com/Teagnes/dsh-xxnerv-telegram)（public，MIT）。
  README 顶部加 CI 徽章，安装命令与克隆地址改为真实仓库，`package.json` 补 `repository` / `homepage` / `bugs`。

## [0.1.0] - 2026-09-29

首个版本。目标运行时：DeepSeek Harness 桌面版 0.1.7-rc.2。

### 新增

- **`xxnerv_telegram_send` 模型工具**：发送一条文本消息，支持 `chat_id` 覆盖、`parse_mode`（`HTML` / `MarkdownV2`）
  与 `silent`；超过 4096 字符按 Telegram 上限截断，返回 `messageId` / `chatId` / `date` / `truncated`。
- **`xxnerv_telegram_config` 模型工具**：`status` 报告生效配置（token 脱敏），`set` 写入 `bot_token` /
  `default_chat_id` / `notify_chat_id` / `proxy_url` / `notify_on_turn_end`，经 harness 配置服务落到
  profile 的 `cordis.patch.yml`。
- **轮次结束自动推送**（默认关闭）：`turn/end` 时把该轮最后的助手文本推送到 `notifyChatId`，
  按 `notifyMaxChars` 截断；默认只推送人发起过的会话，跳过子代理会话与 `forked` / `interrupted`
  这类崩溃修复产生的合成结束事件。
- **HTTP `CONNECT` 代理隧道**：只依赖 Node 内置模块（`node:net` / `node:tls`），支持 `user:pass@host:port`
  形式的代理鉴权；直连不通的网络（如本机系统代理 `http://127.0.0.1:7897`）可正常调用 Bot API。
- **Plugins 页面配置表单**：插件自带浏览器 half，注册到 `plugins.row.config` 槽位
  （键 `dsh-xxnerv-telegram#xxnerv-telegram`），提供 Bot token（密码框，只写不读）、默认会话、通知会话、
  代理地址与「每轮结束推送」开关，Save 写入 profile 并即时生效。
- **运维 CLI `dsh-xxnerv-telegram`**：`getMe`（校验 token）、`updates`（用 `getUpdates` 发现 chat id）、
  `send`（脱离 agent loop 发消息）；支持 `--token/--proxy/--api-base/--timeout` 与
  `DSH_XXNERV_TELEGRAM_BOT_TOKEN` / `DSH_XXNERV_TELEGRAM_PROXY` / `DSH_XXNERV_TELEGRAM_API_BASE` 环境变量回退。
- **bundle 组合包形态**：`cordis.patch.yml` 只插入 `id: xxnerv-telegram` 一行，其余字段由 Schemastery Schema
  默认值补全；`package.json` 的 `dsh.bundle.patch` + `dsh.client` 完成声明，零构建。
- 测试：62 项单元测试（传输、代理隧道、推送策略、配置读写、前端 half 装配渲染），以及
  集成测试（真实 dsh 运行时 + 工具流水线 + 轮次推送 + 配置写入）、UI 回环测试（无头 Chrome）。

### 已知限制

- **只有出站方向**：没有长轮询 / webhook / 命令分发，Telegram 消息无法驱动 dsh。
- **不支持 SOCKS 代理**，只支持 HTTP(S) `CONNECT`。
- `xxnerv_telegram_config set` 返回「已提交」而非「已成功」：配置服务要等本轮调用结束才应用，
  需要再用 `status` 复核一次。
