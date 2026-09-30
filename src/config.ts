import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const isWin = process.platform === 'win32';

function num(name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 按平台查找本机 Chrome 可执行文件；找不到返回 undefined。 */
export function findChrome(): string | undefined {
  const candidates: string[] = [];
  if (isWin) {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return candidates.find((p) => existsSync(p));
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// AI 专用 profile（CDP 模式）：默认放在用户目录下，可用 BROWSER_MCP_PROFILE 改到任意位置
const defaultProfile = join(homedir(), '.browser-mcp', 'chrome-profile');
const userDataDir = env.BROWSER_MCP_PROFILE || defaultProfile;

export const config = {
  /** Chrome 远程调试端口 */
  cdpPort: num('BROWSER_MCP_PORT', 9222),
  /** Chrome 路径（可用环境变量覆盖） */
  chromePath: env.BROWSER_MCP_CHROME || findChrome(),
  /** AI 专用 profile 目录：登录一次，长期保留 */
  userDataDir,
  /** 下载文件保存目录 */
  downloadDir: env.BROWSER_MCP_DOWNLOADS || join(userDataDir, 'downloads'),
  /** 仅用于测试/服务器环境；日常使用保持有界面 */
  headless: env.BROWSER_MCP_HEADLESS === '1',
  /** 追加的 Chrome 启动参数（空格分隔） */
  extraArgs: (env.BROWSER_MCP_ARGS || '').split(' ').filter(Boolean),

  /** 等待浏览器调试端口就绪的最长时间 */
  launchTimeout: num('BROWSER_MCP_LAUNCH_TIMEOUT', 20_000),
  /** 单个元素动作（点击/输入）等待可操作的超时 */
  actionTimeout: num('BROWSER_MCP_ACTION_TIMEOUT', 8_000),
  /** 页面导航超时 */
  navTimeout: num('BROWSER_MCP_NAV_TIMEOUT', 30_000),
  /** 单次工具调用的总超时（兜底，保证绝不无限挂起） */
  toolTimeout: num('BROWSER_MCP_TOOL_TIMEOUT', 60_000),
  /** 动作后等待页面平静的上限 */
  settleMax: num('BROWSER_MCP_SETTLE_MAX', 3_000),
  /** 网络空闲多久视为平静 */
  settleQuiet: num('BROWSER_MCP_SETTLE_QUIET', 300),
  /** 未处理的对话框多久后自动关闭，防止页面卡死 */
  dialogAutoDismissMs: num('BROWSER_MCP_DIALOG_TIMEOUT', 15_000),
  /** 返回给 AI 的快照最大字符数 */
  snapshotMaxChars: num('BROWSER_MCP_SNAPSHOT_MAX', 40_000),

  logDir: env.BROWSER_MCP_LOG_DIR || join(projectRoot, 'logs'),

  // ---------------- 插件模式 ----------------
  /** cdp：独立 profile 的 Chrome；extension：通过插件操作你日常的 Chrome */
  mode: (env.BROWSER_MCP_MODE === 'extension' ? 'extension' : 'cdp') as 'cdp' | 'extension',
  /** 插件连接 MCP 的本机端口（插件设置里要一致） */
  extPort: num('BROWSER_MCP_EXT_PORT', 9230),
  /** 首次配对后保存的令牌 */
  extTokenFile: env.BROWSER_MCP_EXT_TOKEN_FILE || join(homedir(), '.browser-mcp', 'ext-token'),
  /** 等待插件连接的总时长 */
  extConnectTimeout: num('BROWSER_MCP_EXT_CONNECT_TIMEOUT', 20_000),
  /** 等待多久插件还没连上就尝试唤醒 */
  extWakeAfterMs: num('BROWSER_MCP_EXT_WAKE_AFTER', 3_000),

  // ---------------- 安全 ----------------
  /** 危险动作确认：插件模式默认开启，CDP 模式默认关闭（无处弹窗） */
  safety: env.BROWSER_MCP_SAFETY ? env.BROWSER_MCP_SAFETY !== 'off' : env.BROWSER_MCP_MODE === 'extension',
  /** 等待用户确认的最长时间 */
  confirmTimeoutMs: num('BROWSER_MCP_CONFIRM_TIMEOUT', 45_000),
};

export type Config = typeof config;
