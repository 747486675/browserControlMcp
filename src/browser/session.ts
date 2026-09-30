import { mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Dialog, type Download, type Page } from 'playwright-core';
import { config } from '../config.js';
import { ToolError, normalizeError } from '../core/errors.js';
import { log } from '../log.js';
import { getRelay } from '../extension/relay.js';
import { closeBlockedPages, ensureBrowser } from './launcher.js';
import { Tab, TabManager } from './tabs.js';

export interface PendingDialog {
  dialog: Dialog;
  page: Page;
  tab: Tab | undefined;
  type: string;
  message: string;
  defaultValue: string;
  openedAt: number;
  timer: NodeJS.Timeout;
}

export interface DownloadRecord {
  id: number;
  url: string;
  suggestedFilename: string;
  state: 'in_progress' | 'completed' | 'failed' | 'canceled';
  path?: string;
  size?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** 已作为事件在某次工具结果里提示过 */
  announced: boolean;
  /** 已被 wait_for_download 返回过 */
  claimed: boolean;
}

/**
 * 浏览器会话：负责连接、自动重连、标签页、对话框、下载，以及"事件"汇总
 * （事件会附加到下一次工具调用的结果里，让 AI 知道页面上发生了什么）。
 */
export class BrowserSession {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  readonly tabs: TabManager;
  version = '';

  private connecting: Promise<void> | null = null;
  private everConnected = false;
  private events: string[] = [];
  private dialogWaiters = new Set<(d: PendingDialog) => void>();
  private downloadWaiters = new Set<() => void>();
  pendingDialog: PendingDialog | null = null;
  readonly downloads: DownloadRecord[] = [];
  private downloadSeq = 0;

  constructor() {
    this.tabs = new TabManager({
      onOpened: (tab, byActive) => {
        this.pushEvent(`新标签页 ${tab.id} 已打开${byActive ? '（由当前页打开，已自动切换过去）' : ''}：${tab.page.url() || 'about:blank'}`);
      },
      onClosed: (tab) => this.pushEvent(`标签页 ${tab.id} 已关闭`),
    });
  }

  get connected(): boolean {
    return !!this.browser?.isConnected();
  }

  pushEvent(e: string) {
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
  }

  drainEvents(): string[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** 确保已连接。断线则自动重新拉起浏览器并重连（并发调用只连一次）。 */
  async ensure(): Promise<void> {
    if (this.connected && this.context) return;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const wasConnected = this.everConnected;
    this.tabs.clear();
    const browser = config.mode === 'extension' ? await this.connectExtension() : await this.connectCdp();
    // 必须使用默认 context：它才带着 profile 里的 Cookie 和登录态
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new ToolError('BROWSER_LAUNCH_FAILED', '浏览器没有默认 context');
    }
    context.setDefaultTimeout(config.actionTimeout);
    context.setDefaultNavigationTimeout(config.navTimeout);

    this.browser = browser;
    this.context = context;
    this.version = config.mode === 'extension' ? `插件模式（插件 v${getRelay().extensionVersion}）` : browser.version();
    this.everConnected = true;

    browser.on('disconnected', () => {
      log.warn('浏览器连接断开');
      if (this.browser === browser) {
        this.browser = null;
        this.context = null;
        this.tabs.clear();
        this.clearDialog();
      }
    });

    for (const page of context.pages()) this.attachPage(page, false);
    context.on('page', (page) => {
      this.attachPage(page, true);
    });

    if (config.mode === 'cdp') mkdirSync(config.downloadDir, { recursive: true });
    log.info(`已连接浏览器 ${this.version}，现有标签页 ${this.tabs.list().length} 个`);
    if (wasConnected) this.pushEvent('浏览器连接已恢复（自动重连）。之前的 ref 已失效，请重新 snapshot。');
  }

  /** 插件模式：启动中转 → 等插件连上（必要时唤醒）→ Playwright 连中转 */
  private async connectExtension(): Promise<Browser> {
    const relay = getRelay();
    this.attachRelayListeners();
    await relay.waitForExtension(config.extConnectTimeout);
    if (relay.paused) {
      throw new ToolError('USER_PAUSED', '用户在浏览器插件里暂停了 AI 控制');
    }
    try {
      return await chromium.connectOverCDP(relay.cdpEndpoint(), { timeout: 15_000 });
    } catch (e) {
      throw new ToolError('EXTENSION_NOT_CONNECTED', `连接插件中转失败：${(e as Error).message.split('\n')[0]}`, { transient: true, beforeDispatch: true, cause: e });
    }
  }

  private relayListening = false;
  private attachRelayListeners() {
    if (this.relayListening) return;
    this.relayListening = true;
    const relay = getRelay();
    relay.on('handed-off', () => this.pushEvent('另一个 AI 会话接管了浏览器插件；本会话再次调用时会自动接管回来。'));
    relay.on('paused', () => this.pushEvent('用户在浏览器插件里点了"全部停止"，AI 控制已暂停。'));
    relay.on('resumed', () => this.pushEvent('用户已在浏览器插件里恢复 AI 控制。'));
    relay.on('blocked-tab-closed', (url) =>
      this.pushEvent(`连接时发现一个 AI 标签页卡在残留的对话框上，已关闭：${url}（如需要可重新打开）`),
    );
    relay.on('download-created', (item) => this.onExtDownload(item, true));
    relay.on('download-changed', (item) => this.onExtDownload(item, false));
  }

  /** CDP 模式：确保独立 profile 的 Chrome 在运行并连接 */
  private async connectCdp(): Promise<Browser> {
    let ep = await ensureBrowser();
    let browser: Browser | undefined;
    for (let attempt = 0; !browser; attempt++) {
      if (attempt > 0) ep = await ensureBrowser(); // 浏览器可能在上一轮中退出了
      try {
        browser = await chromium.connectOverCDP(ep.httpUrl, { timeout: attempt === 0 ? 8_000 : 12_000 });
      } catch (e) {
        if (attempt < 1) {
          // 最常见原因：某个页面停在残留的对话框上导致渲染进程阻塞。找出并关闭这类页面后重试。
          log.warn('connectOverCDP 失败，检查卡死页面后重试', e);
          const closed = await closeBlockedPages();
          if (closed.length) {
            this.pushEvent(`连接时发现 ${closed.length} 个页面卡在残留的对话框上，已关闭：${closed.join(', ')}（如需要可重新打开）`);
          }
          continue;
        }
        throw new ToolError('BROWSER_LAUNCH_FAILED', `连接浏览器失败：${(e as Error).message.split('\n')[0]}`, { cause: e });
      }
    }
    return browser;
  }

  private attachPage(page: Page, isNew: boolean) {
    page.on('dialog', (d) => this.onDialog(d, page));
    page.once('close', () => {
      // 对话框所在页面被关掉了，对话框也随之消失
      if (this.pendingDialog?.page === page) this.clearDialog();
    });
    page.on('download', (d) => void this.onDownload(d));
    if (isNew) {
      void this.tabs.handleNewPage(page).catch((e) => log.warn('处理新标签页失败', e));
    } else {
      this.tabs.register(page);
    }
  }

  /** 获取当前标签页；没有任何标签页时新建一个 */
  async activeTab(): Promise<Tab> {
    await this.ensure();
    let tab = this.tabs.active;
    if (!tab || tab.closed) {
      const page = await this.context!.newPage();
      tab = this.tabs.register(page, { activate: true });
    }
    return tab;
  }

  async newTab(url?: string): Promise<Tab> {
    await this.ensure();
    const page = await this.context!.newPage();
    // context.on('page') 也会触发登记，这里直接取同一个对象
    const tab = this.tabs.register(page, { activate: true });
    this.tabs.setActive(tab);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront().catch(() => undefined);
    return tab;
  }

  // ---------------- 对话框 ----------------

  private onDialog(dialog: Dialog, page: Page) {
    if (this.pendingDialog) {
      // 理论上同一时间只会有一个；保险起见把新的直接关掉
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    const tab = this.tabs.byPage(page);
    const timer = setTimeout(() => {
      if (this.pendingDialog?.dialog === dialog) {
        log.warn(`对话框超时未处理，自动关闭：${dialog.type()} ${dialog.message()}`);
        void dialog.dismiss().catch(() => undefined);
        this.pushEvent(`对话框 ${dialog.type()}「${dialog.message()}」超过 ${config.dialogAutoDismissMs}ms 未处理，已自动关闭（dismiss）。`);
        this.pendingDialog = null;
      }
    }, config.dialogAutoDismissMs);
    const pd: PendingDialog = {
      dialog,
      page,
      tab,
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      openedAt: Date.now(),
      timer,
    };
    this.pendingDialog = pd;
    log.info(`对话框出现 ${pd.type}: ${pd.message}`);
    for (const w of this.dialogWaiters) w(pd);
  }

  /** 当前仍然有效的待处理对话框（页面已关闭/连接已断开的会被清掉） */
  activeDialog(): PendingDialog | null {
    const pd = this.pendingDialog;
    if (pd && (pd.page.isClosed() || !this.connected)) this.clearDialog();
    return this.pendingDialog;
  }

  /** 返回一个在"下一个对话框出现"时 resolve 的 promise，以及取消函数 */
  waitForDialog(): { promise: Promise<PendingDialog>; cancel: () => void } {
    let resolver!: (d: PendingDialog) => void;
    const promise = new Promise<PendingDialog>((r) => (resolver = r));
    this.dialogWaiters.add(resolver);
    return { promise, cancel: () => this.dialogWaiters.delete(resolver) };
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    let pd = this.activeDialog();
    if (!pd) {
      // 对话框事件可能稍晚到达（尤其插件模式经中转转发），稍等一下
      const w = this.waitForDialog();
      pd = await Promise.race([w.promise, new Promise<null>((r) => setTimeout(() => r(null), 2_000))]);
      w.cancel();
    }
    if (!pd) throw new ToolError('INVALID_ARGUMENT', '当前没有待处理的对话框', { hint: '无需处理。' });
    this.clearDialog();
    try {
      if (accept) await pd.dialog.accept(promptText);
      else await pd.dialog.dismiss();
    } catch (e) {
      throw normalizeError(e);
    }
    return `已${accept ? '确认(accept)' : '取消(dismiss)'}对话框 ${pd.type}「${pd.message}」`;
  }

  private clearDialog() {
    if (this.pendingDialog) clearTimeout(this.pendingDialog.timer);
    this.pendingDialog = null;
  }

  // ---------------- 下载 ----------------

  private async onDownload(d: Download) {
    const rec: DownloadRecord = {
      id: ++this.downloadSeq,
      url: d.url(),
      suggestedFilename: d.suggestedFilename(),
      state: 'in_progress',
      startedAt: Date.now(),
      announced: false,
      claimed: false,
    };
    this.downloads.push(rec);
    if (this.downloads.length > 100) this.downloads.shift();
    log.info(`下载开始 #${rec.id} ${rec.suggestedFilename}`);
    try {
      const failure = await d.failure();
      if (failure) {
        rec.state = failure === 'canceled' ? 'canceled' : 'failed';
        rec.error = failure;
      } else {
        const target = uniquePath(config.downloadDir, rec.suggestedFilename || `download-${rec.id}`);
        await d.saveAs(target);
        rec.path = target;
        rec.size = statSync(target).size;
        rec.state = 'completed';
      }
    } catch (e) {
      rec.state = 'failed';
      rec.error = (e as Error).message.split('\n')[0];
    }
    rec.finishedAt = Date.now();
    log.info(`下载结束 #${rec.id} ${rec.state} ${rec.path ?? rec.error ?? ''}`);
    for (const w of this.downloadWaiters) w();
  }

  /** 插件模式：下载由插件的 chrome.downloads 上报，文件按用户 Chrome 的下载设置保存 */
  private extDownloads = new Map<number, DownloadRecord>();
  private onExtDownload(item: { id: number; url?: string; filename?: string; state?: string; fileSize?: number; error?: string }, created: boolean) {
    let rec = this.extDownloads.get(item.id);
    if (!rec) {
      if (!created && item.state === undefined) return;
      rec = {
        id: ++this.downloadSeq,
        url: item.url ?? '',
        suggestedFilename: basename(item.filename || '') || basename(new URL(item.url || 'http://x/download').pathname) || 'download',
        state: 'in_progress',
        startedAt: Date.now(),
        announced: false,
        claimed: false,
      };
      this.extDownloads.set(item.id, rec);
      this.downloads.push(rec);
      if (this.downloads.length > 100) this.downloads.shift();
      log.info(`下载开始（插件）#${rec.id} ${rec.url}`);
    }
    if (item.filename) {
      rec.path = item.filename;
      rec.suggestedFilename = basename(item.filename.replace(/\\/g, '/'));
    }
    if (item.state === 'complete') {
      rec.state = 'completed';
      rec.size = item.fileSize;
    } else if (item.state === 'interrupted') {
      rec.state = item.error === 'USER_CANCELED' ? 'canceled' : 'failed';
      rec.error = item.error;
    }
    if (rec.state !== 'in_progress') {
      rec.finishedAt = Date.now();
      this.extDownloads.delete(item.id);
      log.info(`下载结束（插件）#${rec.id} ${rec.state} ${rec.path ?? rec.error ?? ''}`);
      for (const w of this.downloadWaiters) w();
    }
  }

  /** 把尚未报告的已结束下载作为事件输出 */
  collectDownloadEvents(): string[] {
    const out: string[] = [];
    for (const r of this.downloads) {
      if (r.announced || r.state === 'in_progress') continue;
      r.announced = true;
      out.push(formatDownload(r));
    }
    const inProgress = this.downloads.filter((r) => r.state === 'in_progress');
    if (inProgress.length) out.push(`有 ${inProgress.length} 个下载进行中：${inProgress.map((r) => r.suggestedFilename).join(', ')}（可调用 wait_for_download 等待）`);
    return out;
  }

  /** 等待下载结束：返回尚未报告的已结束下载；若没有则等待新的下载完成，直到超时 */
  async waitForDownloads(timeoutMs: number): Promise<DownloadRecord[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const done = this.downloads.filter((r) => !r.claimed && r.state !== 'in_progress');
      const inProgress = this.downloads.some((r) => r.state === 'in_progress');
      if (done.length && !inProgress) {
        done.forEach((r) => (r.claimed = r.announced = true));
        return done;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        done.forEach((r) => (r.claimed = r.announced = true));
        return done;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.downloadWaiters.delete(wake);
          resolve();
        };
        const t = setTimeout(wake, Math.min(left, 1000));
        this.downloadWaiters.add(wake);
      });
    }
  }
}

export function formatDownload(r: DownloadRecord): string {
  if (r.state === 'completed') return `下载完成：${r.path}（${formatSize(r.size ?? 0)}）`;
  if (r.state === 'in_progress') return `下载进行中：${r.suggestedFilename}`;
  return `下载${r.state === 'canceled' ? '已取消' : '失败'}：${r.suggestedFilename}（${r.error ?? ''}）`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 生成不重名的保存路径：a.txt -> a (1).txt */
function uniquePath(dir: string, name: string): string {
  const safe = basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let p = join(dir, safe);
  for (let i = 1; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

export const session = new BrowserSession();
