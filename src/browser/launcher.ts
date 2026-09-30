import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { ToolError } from '../core/errors.js';
import { log } from '../log.js';

export interface BrowserEndpoint {
  /** http://127.0.0.1:port，用于 connectOverCDP */
  httpUrl: string;
  /** Chrome 版本字符串 */
  version: string;
  /** 是否复用了已在运行的浏览器 */
  reused: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 探测调试端口是否可用。可用则返回浏览器版本，否则返回 null。 */
export async function probe(port = config.cdpPort, timeoutMs = 1500): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ? data.Browser ?? 'unknown' : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 找出并关闭"卡死"的页面，返回被关闭页面的网址。
 * 背景：页面停在未处理的 alert/confirm 上时，渲染进程被阻塞，Playwright 的 connectOverCDP 会一直挂起；
 * 而新建的 CDP 会话看不到已弹出的对话框，无法用 Page.handleJavaScriptDialog 关掉它。
 * 做法：对每个页面执行一条最简单的 JS，超时无响应即判定为卡死，用浏览器级 Target.closeTarget 关闭。
 * 仅在正常连接超时后才调用，避免误伤。
 */
export async function closeBlockedPages(port = config.cdpPort): Promise<string[]> {
  let targets: { id: string; type: string; url: string; webSocketDebuggerUrl?: string }[] = [];
  let browserWs = '';
  try {
    targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as typeof targets;
    browserWs = ((await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  } catch {
    return [];
  }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const alive = await Promise.all(pages.map((t) => sendOnce(t.webSocketDebuggerUrl!, 'Runtime.evaluate', { expression: '1' }, 1500)));
  const blocked = pages.filter((_, i) => alive[i] === 'timeout');
  if (!blocked.length) return [];
  // 有界面的 Chrome 关掉最后一个标签页会整个退出，所以先补一个空白页
  if (blocked.length === pages.length) {
    await sendOnce(browserWs, 'Target.createTarget', { url: 'about:blank' }, 3000);
  }
  const closed: string[] = [];
  for (const t of blocked) {
    const r = await sendOnce(browserWs, 'Target.closeTarget', { targetId: t.id }, 3000);
    if (r === 'ok') closed.push(t.url);
  }
  if (closed.length) log.warn(`关闭了 ${closed.length} 个卡死的页面：${closed.join(', ')}`);
  return closed;
}

/** 通过一次性 WebSocket 发送单条 CDP 命令 */
function sendOnce(wsUrl: string, method: string, params: object, timeoutMs = 1500): Promise<'ok' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: 'ok' | 'error' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      clearTimeout(timer);
      resolve('error');
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown };
        if (msg.id === 1) finish(msg.error ? 'error' : 'ok');
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => finish('error');
    ws.onclose = () => finish('error');
  });
}

let launching: Promise<BrowserEndpoint> | null = null;

/** 确保有一个开着调试端口的 Chrome：已有就复用，没有就启动。并发调用只会启动一次。 */
export function ensureBrowser(): Promise<BrowserEndpoint> {
  if (!launching) {
    launching = doEnsure().finally(() => {
      launching = null;
    });
  }
  return launching;
}

async function doEnsure(): Promise<BrowserEndpoint> {
  const port = config.cdpPort;
  const httpUrl = `http://127.0.0.1:${port}`;

  const existing = await probe(port);
  if (existing) {
    log.info(`复用已运行的浏览器 ${existing} @ ${httpUrl}`);
    return { httpUrl, version: existing, reused: true };
  }

  const exe = config.chromePath;
  if (!exe) {
    throw new ToolError('BROWSER_LAUNCH_FAILED', '未找到 Chrome 可执行文件', {
      hint: '请安装 Chrome，或设置环境变量 BROWSER_MCP_CHROME 指向 chrome.exe。',
    });
  }

  mkdirSync(config.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(config.headless ? ['--headless=new'] : []),
    // Windows：窗口被其他窗口完全遮挡时 Chrome 会停止绘制，导致截图等操作卡住
    ...(process.platform === 'win32' ? ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'] : []),
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...config.extraArgs,
    'about:blank',
  ];
  log.info(`启动 Chrome: ${exe} ${args.join(' ')}`);

  let exitInfo: string | null = null;
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (e) => {
    exitInfo = `spawn error: ${e.message}`;
  });
  child.on('exit', (code, sig) => {
    exitInfo = `exit code=${code} signal=${sig}`;
  });
  // 不随 MCP 进程退出：浏览器和登录态留给用户
  child.unref();

  const deadline = Date.now() + config.launchTimeout;
  while (Date.now() < deadline) {
    const v = await probe(port, 1000);
    if (v) {
      log.info(`Chrome 已就绪 ${v}`);
      return { httpUrl, version: v, reused: false };
    }
    if (exitInfo && /spawn error/.test(exitInfo)) break;
    await sleep(250);
  }

  // 常见原因：同一个 profile 已被一个没开调试端口的 Chrome 占用，新进程把参数转交给它后立即退出
  throw new ToolError(
    'BROWSER_LAUNCH_FAILED',
    `Chrome 在 ${config.launchTimeout}ms 内没有打开调试端口 ${port}${exitInfo ? `（${exitInfo}）` : ''}`,
    {
      hint:
        `可能原因：1) profile 目录 ${config.userDataDir} 已被另一个未开调试端口的 Chrome 窗口占用，请关闭那个窗口后重试；` +
        `2) 端口 ${port} 被其他程序占用，可用 BROWSER_MCP_PORT 换一个端口；3) Chrome 路径不正确（${exe}）。`,
    },
  );
}
