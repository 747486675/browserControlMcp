/**
 * 插件中转服务：一端连 Chrome 插件，一端伪装成 CDP 浏览器给 Playwright 连。
 *
 * 结构参考 Playwright 的 CDPRelayServer（packages/playwright-core/src/tools/mcp/cdpRelay.ts），
 * Copyright (c) Microsoft Corporation, Apache License 2.0。
 * 增加：固定端口、Origin 校验、首次配对令牌、插件断线后保持服务可重连、自定义 MCP.* 命令、下载/暂停事件。
 */
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import { ToolError } from '../core/errors.js';
import { log } from '../log.js';
import { BrowserModel, type CDPMessage } from './browserModel.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, PROTOCOL_VERSION } from './constants.js';

class ExtensionConnection {
  private callbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  private lastId = 0;
  onmessage?: (method: string, params: any) => void;
  onclose?: (reason: string) => void;

  constructor(private ws: WebSocket) {
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code, reason) => this.dispose(`${code} ${reason.toString()}`));
    ws.on('error', (e) => log.warn('插件连接错误', e));
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.open) return Promise.reject(new Error('Extension not connected'));
    const id = ++this.lastId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`插件响应超时：${method}`));
      }, timeoutMs);
      this.callbacks.set(id, { resolve, reject, method, timer });
    });
  }

  close(reason: string) {
    if (this.open) this.ws.close(1000, reason.slice(0, 120));
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.ws.close(1003, 'malformed json');
      return;
    }
    if (msg.id !== undefined) {
      const cb = this.callbacks.get(msg.id);
      if (!cb) return;
      this.callbacks.delete(msg.id);
      clearTimeout(cb.timer);
      if (msg.error) cb.reject(new Error(typeof msg.error === 'string' ? msg.error : msg.error.message ?? JSON.stringify(msg.error)));
      else cb.resolve(msg.result);
    } else if (msg.method) {
      this.onmessage?.(msg.method, msg.params);
    }
  }

  private dispose(reason: string) {
    for (const cb of this.callbacks.values()) {
      clearTimeout(cb.timer);
      cb.reject(new Error('Extension disconnected'));
    }
    this.callbacks.clear();
    this.onclose?.(reason);
  }
}

export interface RelayEvents {
  paused: [];
  resumed: [];
  'extension-connected': [];
  'extension-disconnected': [reason: string];
  'download-created': [item: any];
  'download-changed': [item: any];
  'blocked-tab-closed': [url: string];
  'handed-off': [];
}

export class RelayServer extends EventEmitter<RelayEvents> {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private starting: Promise<void> | null = null;
  private ext: ExtensionConnection | null = null;
  private cdp: WebSocket | null = null;
  private ready = false;
  private readyWaiters = new Set<() => void>();
  readonly model: BrowserModel;
  private readonly cdpPath = `/cdp/${randomUUID()}`;
  paused = false;
  extensionVersion = '';

  constructor() {
    super();
    this.model = new BrowserModel(
      (method, params) => this.callExtension(method, params),
      (url) => this.emit('blocked-tab-closed', url),
    );
  }

  get port() {
    return config.extPort;
  }

  get extensionReady(): boolean {
    return !!this.ext?.open && this.ready;
  }

  cdpEndpoint(): string {
    return `ws://127.0.0.1:${this.port}${this.cdpPath}`;
  }

  /**
   * 开始监听。
   * takeover=true：端口被另一个 browser-mcp 实例占用时，请求它交出端口（真正要操作浏览器时才这样做）。
   * 背景：Claude 桌面版会同时启动多份 MCP 实例（不同会话各一份），同一时间只有一份能连插件，
   *      所以采用"谁在用谁接管"：被接管的实例以后再被调用时，会用同样的方式接管回来。
   */
  start(opts: { takeover?: boolean } = {}): Promise<void> {
    if (this.server) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStartWithTakeover(!!opts.takeover).then(
        () => {
          this.starting = null;
        },
        (e) => {
          this.starting = null;
          throw e;
        },
      );
    }
    return this.starting;
  }

  private async doStartWithTakeover(takeover: boolean): Promise<void> {
    try {
      return await this.doStart();
    } catch (e) {
      if (!takeover || (e as ToolError & { errno?: string }).cause !== 'EADDRINUSE') throw e;
    }
    log.info(`端口 ${this.port} 被另一个 browser-mcp 实例占用，请求它交出插件控制`);
    const ok = await requestHandoff(this.port);
    if (!ok) {
      throw new ToolError('EXTENSION_NOT_CONNECTED', `端口 ${this.port} 被其他程序占用，且对方不是可交接的 browser-mcp 实例`, {
        hint: `请用 BROWSER_MCP_EXT_PORT 换一个端口（插件"设置"里也要改成同一个端口）。`,
      });
    }
    let lastErr: unknown;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        await this.doStart();
        log.info('已接管插件控制');
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** 交出端口：断开插件和 Playwright，停止监听（另一个实例要接管时调用） */
  private stopForHandoff() {
    log.warn('另一个 browser-mcp 实例接管了插件控制，本实例释放端口');
    this.ext?.close('handoff');
    this.ext = null;
    this.ready = false;
    this.model.clearAll();
    this.closeCdp('handoff');
    const server = this.server;
    this.server = null;
    this.wss?.close();
    this.wss = null;
    server?.close();
    server?.closeAllConnections();
    this.emit('handed-off');
  }

  private doStart(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/handoff' && req.method === 'POST') {
          // 只接受持有同一配对令牌的 browser-mcp 实例（自定义请求头 + 非简单请求，网页无法伪造）
          const secret = String(req.headers['x-browser-mcp-handoff'] || '');
          if (!handoffSecretMatches(secret)) {
            res.writeHead(403);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pid: process.pid }));
          setImmediate(() => this.stopForHandoff());
          return;
        }
        if (url.pathname === '/wake') {
          // 唤醒页：用 externally_connectable 通知插件立即连接（插件只会按自己保存的端口连接）
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(WAKE_PAGE);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/extension') {
          const reject = this.checkExtensionRequest(req, url);
          if (reject) {
            log.warn(`拒绝插件连接：${reject}`);
            wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, reject));
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => this.onExtensionConnection(ws, url));
        } else if (url.pathname === this.cdpPath) {
          // Playwright 连接：只允许本进程（路径是随机 UUID），且不带浏览器 Origin
          if (req.headers.origin) {
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => this.onPlaywrightConnection(ws));
        } else {
          socket.destroy();
        }
      });
      server.once('error', (e: NodeJS.ErrnoException) => {
        reject(
          new ToolError('EXTENSION_NOT_CONNECTED', `插件中转端口 ${this.port} 无法监听：${e.code ?? e.message}`, {
            cause: e.code,
            hint:
              e.code === 'EADDRINUSE'
                ? `端口 ${this.port} 被占用。可能是另一个 AI 会话正在使用插件模式（下次调用会自动接管），或者被其他程序占用（可用 BROWSER_MCP_EXT_PORT 换端口，插件设置里也要改成同一个端口）。`
                : undefined,
          }),
        );
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.wss = wss;
        log.info(`插件中转已启动 ws://127.0.0.1:${this.port}/extension`);
        resolve();
      });
    });
  }

  // ---------------- 插件连接 ----------------

  private checkExtensionRequest(req: http.IncomingMessage, url: URL): string | null {
    if (req.headers.origin !== EXTENSION_ORIGIN) return `origin 不匹配（${req.headers.origin ?? '无'}）`;
    const v = Number(url.searchParams.get('v'));
    if (v !== PROTOCOL_VERSION) return `协议版本不匹配（插件 ${v}，MCP ${PROTOCOL_VERSION}），请更新插件`;
    if (this.ext?.open) return '已有插件连接';
    const token = url.searchParams.get('token') || '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return '缺少配对令牌';
    const saved = readToken();
    if (!saved) {
      // 首次配对：信任第一个带合法 Origin 的插件，记住它的令牌
      saveToken(token);
      log.info('插件首次配对成功，令牌已保存');
      return null;
    }
    const a = Buffer.from(saved);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return '配对令牌不匹配（如需重新配对，删除 ' + config.extTokenFile + ' 后重试）';
    return null;
  }

  private onExtensionConnection(ws: WebSocket, url: URL) {
    const conn = new ExtensionConnection(ws);
    this.ext = conn;
    this.ready = false;
    this.extensionVersion = url.searchParams.get('ext') || '';
    log.info(`插件已连接（插件版本 ${this.extensionVersion}）`);
    conn.onmessage = (method, params) => this.onExtensionEvent(method, params);
    conn.onclose = (reason) => {
      if (this.ext !== conn) return;
      log.warn(`插件断开：${reason}`);
      this.ext = null;
      this.ready = false;
      this.model.clearAll();
      this.closeCdp('extension disconnected');
      this.emit('extension-disconnected', reason);
    };
  }

  private onExtensionEvent(method: string, params: any) {
    switch (method) {
      case 'chrome.debugger.onEvent': {
        const [source, cdpMethod, cdpParams] = params;
        this.model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case 'chrome.debugger.onDetach':
        log.info(`插件：调试器从标签页 ${params[0]?.tabId} 断开（${params[1]}）`);
        this.model.onDebuggerDetach(params[0]);
        break;
      case 'chrome.tabs.onCreated':
        log.info(`插件：AI 标签页 ${params[0]?.id} 加入 ${params[0]?.url ?? ''}`);
        this.model.onTabCreated(params[0]);
        break;
      case 'chrome.tabs.onRemoved':
        log.info(`插件：AI 标签页 ${params[0]} 移除`);
        this.model.onTabRemoved(params[0]);
        break;
      case 'extension.initialized':
        this.paused = !!params?.paused;
        this.ready = true;
        for (const w of this.readyWaiters) w();
        this.readyWaiters.clear();
        this.emit('extension-connected');
        break;
      case 'extension.paused':
        log.warn('用户在插件中暂停了 AI 控制');
        this.paused = true;
        this.emit('paused');
        // 所有标签页已被插件释放；让 Playwright 端看到断开，后续调用会得到 USER_PAUSED
        this.model.clearAll();
        this.closeCdp('paused by user');
        break;
      case 'extension.resumed':
        log.info('用户恢复了 AI 控制');
        this.paused = false;
        this.emit('resumed');
        break;
      case 'downloads.created':
        this.emit('download-created', params);
        break;
      case 'downloads.changed':
        this.emit('download-changed', params);
        break;
      case 'ping':
        break;
      default:
        log.debug(`未知插件事件 ${method}`);
    }
  }

  /** 调用插件的 RPC 方法（白名单在插件侧校验） */
  callExtension(method: string, params: unknown[], timeoutMs?: number): Promise<any> {
    if (!this.ext?.open) return Promise.reject(new ToolError('EXTENSION_NOT_CONNECTED', '浏览器插件未连接'));
    return this.ext.send(method, params, timeoutMs);
  }

  /** 等待插件连接并完成握手；超时前会尝试唤醒一次 */
  async waitForExtension(timeoutMs: number): Promise<void> {
    await this.start({ takeover: true });
    if (this.extensionReady) return;
    const deadline = Date.now() + timeoutMs;
    let woke = false;
    while (!this.extensionReady && Date.now() < deadline) {
      if (!woke && Date.now() > deadline - timeoutMs + config.extWakeAfterMs) {
        woke = true;
        this.wakeExtension();
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 250);
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.readyWaiters.add(done);
      });
    }
    if (!this.extensionReady) {
      throw new ToolError('EXTENSION_NOT_CONNECTED', `等待 ${Math.round(timeoutMs / 1000)} 秒后浏览器插件仍未连接`, {
        hint:
          '请确认：1) Chrome 已打开，且已安装并启用 browser-mcp 插件（chrome://extensions，开发者模式→加载已解压的扩展程序→选择项目里的 extension 文件夹）；' +
          `2) 插件弹窗里显示的端口是 ${this.port}；3) 插件没有被设为"暂停"。`,
      });
    }
  }

  /** 用 chrome.exe 打开本机唤醒页，唤醒可能在休眠中的插件后台（Chrome 没开时也会顺带启动 Chrome） */
  wakeExtension() {
    const exe = config.chromePath;
    if (!exe || process.env.BROWSER_MCP_NO_WAKE === '1') return;
    const url = `http://127.0.0.1:${this.port}/wake`;
    log.info(`尝试唤醒插件：${exe} ${url}`);
    try {
      const args = [
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        ...config.extraArgs,
        url,
      ];
      spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (e) {
      log.warn('唤醒插件失败', e);
    }
  }

  // ---------------- Playwright 连接 ----------------

  private onPlaywrightConnection(ws: WebSocket) {
    if (!this.extensionReady) {
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this.cdp && this.cdp.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this.cdp = ws;
    this.model.connectOverCDP((m) => this.sendToCdp(m));
    ws.on('message', (data) => void this.onPlaywrightMessage(JSON.parse(data.toString())));
    ws.on('close', () => {
      if (this.cdp !== ws) return;
      this.cdp = null;
      log.info('Playwright 连接关闭，释放插件调试器');
      void this.model.reset();
    });
    ws.on('error', (e) => log.warn('Playwright 连接错误', e));
  }

  private closeCdp(reason: string) {
    if (this.cdp?.readyState === WebSocket.OPEN) this.cdp.close(1000, reason);
    this.cdp = null;
  }

  private sendToCdp(m: CDPMessage) {
    if (this.cdp?.readyState === WebSocket.OPEN) this.cdp.send(JSON.stringify(m));
  }

  private async onPlaywrightMessage(msg: CDPMessage) {
    const { id, sessionId, method, params } = msg;
    try {
      const result = await this.handleCdpCommand(method!, params, sessionId);
      this.sendToCdp({ id, sessionId, result });
    } catch (e) {
      this.sendToCdp({ id, sessionId, error: { message: (e as Error).message } });
    }
  }

  private browserSessions = new Set<string>();

  private async handleCdpCommand(method: string, params: any, rawSessionId?: string): Promise<any> {
    // 伪造的"浏览器级会话"（Target.attachToBrowserTarget 产生）等同于根会话
    const sessionId = rawSessionId && this.browserSessions.has(rawSessionId) ? undefined : rawSessionId;
    switch (method) {
      case 'Target.attachToBrowserTarget': {
        const id = `mcp-browser-${randomUUID()}`;
        this.browserSessions.add(id);
        return { sessionId: id };
      }
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Chrome/browser-mcp-extension', userAgent: 'browser-mcp', jsVersion: '' };
      case 'Browser.setDownloadBehavior':
        return {}; // 下载由插件的 chrome.downloads 负责
      case 'Target.setAutoAttach':
        if (sessionId) break; // 标签页内的 auto-attach 交给 chrome.debugger
        await this.model.enableAutoAttach();
        return {};
      case 'Target.createTarget':
        if (this.paused) throw new Error('AI 控制已被用户在插件中暂停');
        return this.model.createTarget(params?.url);
      case 'Target.closeTarget':
        return this.model.closeTarget(params?.targetId);
      case 'Target.getTargetInfo':
        if (!sessionId) return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        return { targetInfo: this.model.getTargetInfo(sessionId) };
      case 'Target.attachToTarget':
        if (sessionId) break;
        return this.model.attachToTarget(params?.targetId);
      case 'Target.detachFromTarget':
        if (sessionId) break;
        return this.model.detachFromTarget(params?.sessionId);
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'MCP.getTabId': {
        const tabId = sessionId ? this.model.tabIdForSession(sessionId) : undefined;
        if (tabId === undefined) throw new Error('unknown session');
        return { tabId };
      }
    }
    if (!sessionId) {
      // 浏览器级命令：没有已附加的标签页时，对无关紧要的命令直接返回空结果
      if (!this.model.hasAttachedTabs()) return {};
      return this.model.sendBrowserCommand(method, params);
    }
    return this.model.sendCommand(sessionId, method, params);
  }
}

const WAKE_PAGE = `<!doctype html><meta charset="utf-8"><title>browser-mcp</title>
<body style="font:14px system-ui;padding:24px">正在唤醒 browser-mcp 插件…此页面会自动关闭。<br><small id="s"></small>
<script>
try {
  chrome.runtime.sendMessage('${EXTENSION_ID}', { type: 'wake' }, () => {
    document.getElementById('s').textContent = chrome.runtime.lastError ? '未检测到插件，请确认已安装并启用 browser-mcp 插件。' : '已唤醒。';
  });
} catch (e) {
  document.getElementById('s').textContent = '未检测到插件，请确认已安装并启用 browser-mcp 插件。';
}
</script>`;

// ---------------- 实例间交接 ----------------

/** 交接口令：同一台电脑上的 browser-mcp 实例共享同一个配对令牌文件；尚未配对时使用固定口令 */
function handoffSecret(): string {
  return readToken() ?? 'unpaired';
}

function handoffSecretMatches(secret: string): boolean {
  const mine = Buffer.from(handoffSecret());
  const theirs = Buffer.from(secret);
  return mine.length === theirs.length && timingSafeEqual(mine, theirs);
}

async function requestHandoff(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/handoff`, {
      method: 'POST',
      headers: { 'x-browser-mcp-handoff': handoffSecret() },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------- 配对令牌 ----------------

function readToken(): string | null {
  try {
    if (!existsSync(config.extTokenFile)) return null;
    const t = readFileSync(config.extTokenFile, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function saveToken(token: string) {
  mkdirSync(dirname(config.extTokenFile), { recursive: true });
  writeFileSync(config.extTokenFile, token, { mode: 0o600 });
}

/** 供测试使用：生成一个合法格式的令牌 */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

let relay: RelayServer | null = null;
export function getRelay(): RelayServer {
  if (!relay) relay = new RelayServer();
  return relay;
}

