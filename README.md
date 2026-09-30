# browser-mcp

**让 AI 通过 MCP 操作真实、可见的 Chrome**：打开网页、点击、输入、下载、读取内容。支持 Claude、Codex、Cursor 等所有支持 MCP 的 AI 客户端。

> English: An MCP server that lets AI agents drive a real, visible Chrome — either a dedicated profile (CDP mode) or **your everyday Chrome via an extension** (extension mode, with per-action user confirmation for risky operations). Docs below are in Chinese.

- 🖥️ **真实浏览器**：用的是你电脑上的 Chrome，你能看着 AI 一步步操作。
- 🔑 **免重复登录**：
  - 插件模式直接使用你日常 Chrome 的登录状态；
  - CDP 模式用一个 AI 专用的 Chrome，登录一次长期保留。
- 🛡️ **安全可控**：
  - AI 只能操作“AI”标签页分组；
  - 提交、支付、删除、输入密码等危险动作必须你在浏览器里点“允许”；
  - 敏感网站（网银、支付、邮箱）上的任何操作都要确认；
  - 可以一键停止。
- 🧱 **稳定**：
  - 元素引用失效会立即报错，绝不误点；
  - 自动等待元素可点击、页面加载完成；
  - 处理弹窗和对话框；
  - 断线自动重连；
  - 每次调用都有超时，不会卡死。
- 📄 **大页面友好**：`find` 按关键词定位元素，`read_text` 分段读取表格和文章，不怕几百行的列表。

---

## 两种模式

| | CDP 模式（默认） | 插件模式（推荐） |
|---|---|---|
| 操作哪个浏览器 | 一个 AI 专用的 Chrome 窗口 | **你日常用的 Chrome**，只限“AI”标签页分组 |
| 登录态 | 在 AI 窗口里登录一次，长期保留 | 直接用你现有的登录、书签、插件 |
| 需要安装 | 不需要 | 在 Chrome 里加载本项目的 `extension` 插件 |
| 危险动作确认 | 默认关闭 | 默认开启 |
| 适合 | 让 AI 在隔离环境里干活 | 让 AI 帮你处理需要登录的网站 |

---

## 快速开始

### 1. 准备

- [Node.js](https://nodejs.org/) **22 或更高版本**
- Google Chrome
- 支持 MCP 的 AI 客户端：Claude 桌面版、Claude Code、Codex、Cursor 等

### 2. 下载并安装

```bash
git clone https://github.com/<your-name>/browser-mcp.git
cd browser-mcp
npm install        # 会自动编译，生成 dist/
```

下文用 `<项目路径>` 代表你 clone 下来的目录，例如 `D:/code/browser-mcp`。Windows 上建议在配置里写正斜杠 `/`，就不用转义了。

### 3. 接入 AI 客户端

下面以**插件模式**为例。想用 CDP 模式，去掉 `BROWSER_MCP_MODE` 这项即可。

<details open>
<summary><b>Claude 桌面版</b></summary>

打开 **设置 → 开发者 → 编辑配置**，加入：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["<项目路径>/dist/index.js"],
      "env": { "BROWSER_MCP_MODE": "extension" }
    }
  }
}
```

保存后**从托盘图标完全退出**，再重新打开 Claude。

> 配置文件位置：
> - 官网安装版：`%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`）
> - 微软商店版：`%LOCALAPPDATA%\Packages\Claude_<随机后缀>\LocalCache\Roaming\Claude\claude_desktop_config.json`
>
> 用“编辑配置”按钮打开最省事。
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add browser -e BROWSER_MCP_MODE=extension -- node <项目路径>/dist/index.js
```
</details>

<details>
<summary><b>Codex</b></summary>

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.browser]
command = "node"
args = ["<项目路径>/dist/index.js"]
tool_timeout_sec = 120
env = { BROWSER_MCP_MODE = "extension" }
```

`tool_timeout_sec` 建议设为 120。等你点确认弹窗、等页面加载都需要时间，Codex 默认的 60 秒可能不够。
</details>

<details>
<summary><b>Cursor / 其他客户端</b></summary>

Cursor 编辑 `~/.cursor/mcp.json`，格式与 Claude 桌面版相同：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["<项目路径>/dist/index.js"],
      "env": { "BROWSER_MCP_MODE": "extension" }
    }
  }
}
```

其他客户端只要支持 stdio 类型的 MCP 服务，填写同样的命令、参数和环境变量即可。
</details>

### 4. 安装 Chrome 插件（仅插件模式，一次性）

1. Chrome 打开 `chrome://extensions`；
2. 打开右上角 **开发者模式**；
3. 点 **加载已解压的扩展程序**，选择项目里的 `extension` 文件夹；
4. 出现紫色图标的 **browser-mcp** 就说明装好了。建议点工具栏的拼图图标，把它**固定**出来。

安装时 Chrome 会提示插件需要“读取和更改所有网站上的数据”“调试程序”等权限，这是操作网页必需的。

### 5. 试一下

对 AI 说：

> 用浏览器打开 github.com 的通知页，告诉我有没有未读通知

你会看到：
- 当前窗口里出现一个紫色的 **“AI”标签页分组**；
- 页面顶部出现“browser-mcp 已开始调试此浏览器”的提示条；
- AI 直接使用你已登录的身份打开页面。

---

## 使用示例

- “打开 12306，查 10 月 7 日徐州到南京的高铁，列出上午有二等座的车次”
- “在京东搜索 4TB 移动硬盘，把销量前 5 的名称和价格整理成表格”
- “打开这个网址，点‘导出 Excel’，告诉我文件存在哪里”
- “帮我在这个表单里填上姓名张三、城市上海，**先别提交**，我确认后再提交”

**小建议：**
- 涉及提交、付款、发消息的任务，可以在指令里加一句“提交前先问我”；
- 遇到验证码、扫码登录，AI 会停下来请你在浏览器里自己操作。

---

## 插件模式详解

### AI 能操作哪些标签页

| 情况 | 结果 |
|---|---|
| AI 新开的标签页 | 自动放进当前窗口的 **“AI”分组** |
| AI 标签页里弹出的新页面 | 自动加入分组 |
| 你把某个标签页**拖进** AI 分组 | 交给 AI 控制 |
| 你把标签页**拖出**分组 | AI 立即失去对它的控制 |
| 分组外的标签页 | AI 看不到，也碰不到 |

AI 在后台标签页里也能正常点击、输入，**不会抢走你正在看的标签页**。

### 插件图标

| 图标 | 含义 |
|---|---|
| 灰色，没有数字 | 没连上 MCP：AI 客户端没开，或没用插件模式 |
| 紫色，带数字 | 已连接，数字是 AI 正在控制的标签页数 |
| 红色“停” | 已暂停 |

点图标可以查看状态，点 **全部停止** 立即断开所有控制。暂停期间，AI 的所有调用都会收到 `USER_PAUSED`，直到你点“恢复”。

点浏览器顶部提示条上的“取消”，效果也等于全部停止。

### 安全机制

1. **危险动作要你确认**：插件会弹出确认窗口，写明网站、动作、目标元素，以及 AI 要输入的内容（密码会打码）。需要确认的情况：
   - 点击“提交、发送、发布、确认、购买、支付、下单、删除、转账、授权、退出登录……”这类按钮；
   - 点击会以 POST 方式提交的表单按钮（搜索框这类 GET 表单不会弹窗）；
   - 在密码、验证码、银行卡号输入框里输入；
   - 在 POST 表单里按回车提交。
2. **敏感网站**：网银、支付宝、微信支付、PayPal、券商、各大邮箱、账号安全页面等。在这些网站上，**任何**点击、输入、按键都要确认，而且不能设为信任。列表可在插件“设置”里修改。
3. **确认窗口的三个选项**：“允许这一次”、“拒绝”、“允许并以后信任此网站”。超时 45 秒或直接关掉窗口，都算拒绝。AI 收到 `ACTION_DENIED` 后不会重试，而是会来问你。
4. **确认只能你来点**：确认窗口在浏览器里弹出，AI 无法替你点“允许”。
5. **网页内容不可信**：AI 被要求把网页里出现的“指令”都当成普通数据，不去执行，以防网页里藏着诱导 AI 的文字。
6. **审计日志**：
   - 每个动作都记录在 `logs/audit-日期.jsonl`；
   - 插件的“设置”页能看到最近的确认记录。
7. **连接鉴权**：
   - 只监听 `127.0.0.1`；
   - 只接受来自本插件（固定 ID）的连接；
   - 首次连接时自动配对，令牌保存在 `~/.browser-mcp/ext-token`。

> 危险动作是按按钮文字和输入框属性来判断的，属于尽力而为的规则，不可能覆盖所有情况。特别在意的网站，请加进“敏感网站”列表。

### 多个 AI 轮流使用

Claude、Codex、Cursor 可以都配置插件模式。

- 同一时间插件只连一个 MCP 实例：**哪个 AI 调用浏览器工具，哪个就自动接管插件**，切换大约 1～2 秒；另一个下次调用时再接管回来。
- Claude 桌面版自己也会为不同会话同时启动多份 MCP 实例，同样靠这个机制自动交接。
- 这个设计适合**轮流**使用，不适合两个 AI **同时**操作浏览器。

### 下载

插件模式下，文件按你 Chrome 自己的下载设置保存（通常在“下载”文件夹），`wait_for_download` 会返回完整路径。

如果开启了“下载前询问每个文件的保存位置”，会弹出保存对话框，需要你手动处理。

---

## CDP 模式详解

- 第一次调用时自动打开一个**独立的 Chrome 窗口**，数据目录默认是 `~/.browser-mcp/chrome-profile`。
- 在这个窗口里手动登录需要的网站，登录状态会一直保留。
- 窗口可以一直开着：MCP 重启后会自动复用；窗口被关掉，下次调用时自动重新打开。
- 下载的文件保存在 `<profile>/downloads`。

> Chrome 136 起不允许对你日常用的数据目录开启调试端口，所以 CDP 模式必须使用独立的 profile。想让 AI 用你日常的 Chrome，请用插件模式。

---

## 工具列表

| 工具 | 作用 |
|---|---|
| `navigate` | 打开网址。默认返回带 `[ref=eN]` 的页面快照；页面很大时可设 `snapshot=false` |
| `snapshot` | 获取页面结构快照，可用 `ref` 只取某个区域、用 `depth` 限制层级 |
| `find` | 按关键词查找元素，只返回匹配项及其 ref，适合大页面 |
| `read_text` | 读取页面或某个区域的纯文本，内容过长时用 `offset` 分段读取 |
| `click` / `type` / `select_option` / `hover` / `press_key` / `scroll` | 通过 ref 操作元素 |
| `wait_for` | 等文字出现或消失，或等待固定毫秒数 |
| `tabs` | 列出、新建、切换、关闭标签页 |
| `handle_dialog` | 处理 alert、confirm、prompt 对话框 |
| `wait_for_download` | 等待下载完成并返回文件路径 |
| `screenshot` | 截图（可视区域、整页或某个元素） |
| `go_back` / `go_forward` / `reload` | 后退、前进、刷新 |
| `browser_status` | 查看模式、连接状态、标签页、对话框、下载 |

**错误码：**

| 错误码 | 含义 |
|---|---|
| `REF_STALE` | 页面变了，需要重新 snapshot |
| `ELEMENT_NOT_INTERACTABLE` | 元素被遮挡或不可用 |
| `DIALOG_OPEN` | 有对话框待处理 |
| `ACTION_DENIED` | 用户拒绝了这个操作 |
| `USER_PAUSED` | 用户暂停了 AI 控制 |
| `EXTENSION_NOT_CONNECTED` | 插件没有连上 |

每个错误都会附带下一步建议，方便 AI 自行恢复。

---

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BROWSER_MCP_MODE` | `cdp` | `cdp` 或 `extension` |
| `BROWSER_MCP_EXT_PORT` | `9230` | 插件模式的本机端口（插件“设置”里要一致） |
| `BROWSER_MCP_SAFETY` | 插件模式开启 | 设为 `off` 关闭危险动作确认（不建议） |
| `BROWSER_MCP_CONFIRM_TIMEOUT` | `45000` | 等你确认的最长时间（毫秒） |
| `BROWSER_MCP_PORT` | `9222` | CDP 模式的调试端口 |
| `BROWSER_MCP_PROFILE` | `~/.browser-mcp/chrome-profile` | CDP 模式的 AI 专用 profile 目录 |
| `BROWSER_MCP_DOWNLOADS` | `<profile>/downloads` | CDP 模式的下载目录 |
| `BROWSER_MCP_CHROME` | 自动查找 | Chrome 可执行文件路径 |
| `BROWSER_MCP_ACTION_TIMEOUT` | `8000` | 元素动作超时（毫秒） |
| `BROWSER_MCP_NAV_TIMEOUT` | `30000` | 页面导航超时 |
| `BROWSER_MCP_TOOL_TIMEOUT` | `60000` | 单次调用总超时 |
| `BROWSER_MCP_DIALOG_TIMEOUT` | `15000` | 对话框多久没处理就自动关闭 |
| `BROWSER_MCP_SNAPSHOT_MAX` | `40000` | 快照最大字符数 |
| `BROWSER_MCP_LOG_DIR` | `<项目路径>/logs` | 日志目录 |
| `BROWSER_MCP_DEBUG` | `0` | 设为 `1` 时把调试日志也输出到 stderr |

---

## 常见问题

**插件图标一直是灰色**
- 确认 AI 客户端的配置里有 `BROWSER_MCP_MODE=extension`，并且改完后重启过客户端；
- 插件“设置”里的端口要和 `BROWSER_MCP_EXT_PORT` 一致（默认都是 9230）。

**报 `EXTENSION_NOT_CONNECTED`**
- 确认 Chrome 已打开、插件已启用；
- 如果提示端口被“其他程序”占用，用 `BROWSER_MCP_EXT_PORT` 换一个端口，插件“设置”里也要改成同样的端口。

**插件提示“配对令牌不匹配”**
- 通常是重装了插件。删除 `~/.browser-mcp/ext-token`，再重启 AI 客户端，会自动重新配对。

**CDP 模式报 `BROWSER_LAUNCH_FAILED`**
- 多半是 AI 专用 profile 目录被一个没带调试端口的 Chrome 窗口占用了，关掉那个窗口再试；
- Chrome 不在默认位置时，用 `BROWSER_MCP_CHROME` 指定路径。

**AI 读 12306 这类大列表时信息不全**
- 让 AI 用 `read_text` 读取文字，或者用 `find` 按车次号定位。MCP 给 AI 的内置说明里已经包含这些提示，AI 一般会自动这么做。

**截图失败**
- 浏览器窗口被最小化、被遮挡或屏幕锁定时，页面会暂停渲染，截图可能失败；
- `snapshot`、`find`、`read_text` 不受影响。

---

## 已知限制

- AI 操作期间，Chrome 顶部会显示调试提示条。这是 Chrome 的强制行为，网站检测不到它。
- 插件无法操作 `chrome://` 页面、Chrome 应用商店页面，也无法跳转到 `data:` 网址。
- 危险动作识别基于规则，无法 100% 覆盖。
- 插件模式适合多个 AI **轮流**使用，不支持同时操作。
- 验证码、扫码登录、人机校验需要你本人完成。

---

## 架构

```
AI 客户端 ──stdio── browser-mcp ──Playwright──┬── CDP 模式：Chrome（独立 profile，调试端口 9222）
                                              └── 插件模式：本机中转 127.0.0.1:9230 ──WebSocket── Chrome 插件 ──chrome.debugger── “AI”分组里的标签页
```

- **页面快照和元素引用**：使用 Playwright 的 `ariaSnapshot({ mode: 'ai' })` 生成 `[ref=eN]`，再用 `aria-ref=eN` 找回元素。
- **统一执行流水线**，每个动作都按这个顺序执行：
  1. 确保已连接；
  2. 检查有没有待处理的对话框；
  3. 在当前标签页的串行队列里排队；
  4. 执行动作，同时监视有没有新弹出的对话框；
  5. 等页面平静下来；
  6. 汇总这一步发生的事件；
  7. 按需附带页面快照。
- **插件中转**：思路移植自 Playwright 官方插件模式，让 Playwright 以为自己连的是一个普通浏览器。

---

## 开发与测试

```bash
npm run build     # 编译
npm run smoke     # CDP 模式端到端回归（会弹出一个测试用 Chrome，端口 9444，跑完自动关闭）
npm run inspect   # 用 MCP Inspector 手动逐个调用工具
```

插件模式的回归需要能加载未打包插件的 Chromium（Chrome 正式版从 137 起不支持 `--load-extension`）：

```bash
BROWSER_MCP_MODE=extension SMOKE_CHROME=/path/to/chromium npx tsx test/smoke.ts   # Linux 服务器上加 xvfb-run -a
```

当前回归规模：CDP 模式 28 项，插件模式 41 项。插件模式多出的是这些专项：
- 分组隔离、拖出分组收回控制；
- 真实确认弹窗、关窗即拒绝、敏感网站；
- 全部停止与恢复；
- 连接鉴权、多实例交替接管；
- 大页面的 `find` / `read_text`。

**目录结构：**

```
src/
  index.ts            MCP 服务入口
  config.ts           配置（环境变量）
  browser/            会话、标签页、快照、CDP 模式启动器
  core/               执行流水线、错误标准化
  extension/          插件模式中转（relay、browserModel）
  safety/             危险动作判定、审计日志
  tools/              各个 MCP 工具
extension/            Chrome 插件（MV3）
test/                 端到端回归与测试页面
```

---

## 许可

- 本项目使用 [MIT](LICENSE) 许可。
- `src/extension/browserModel.ts` 与 `src/extension/relay.ts` 的部分实现移植自 [Playwright](https://github.com/microsoft/playwright)（Apache-2.0），详见 [NOTICE](NOTICE)。
