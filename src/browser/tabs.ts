import type { CDPSession, Page, Request } from 'playwright-core';
import { config } from '../config.js';
import { log } from '../log.js';

/** 每个标签页的运行时状态 */
export class Tab {
  readonly id: string;
  readonly page: Page;
  /** 进行中的网络请求（用于判断页面是否平静） */
  readonly inflight = new Map<Request, number>();
  lastNetActivity = Date.now();
  /** 主框架导航计数，用于检测动作是否引发了跳转 */
  navCount = 0;
  private cdp: CDPSession | null = null;
  /** 串行队列：同一标签页上的动作不会交错执行 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(id: string, page: Page) {
    this.id = id;
    this.page = page;

    const onStart = (r: Request) => {
      // 长连接类请求不计入（否则永远不平静）
      const t = r.resourceType();
      if (t === 'websocket' || t === 'eventsource' || t === 'media') return;
      this.inflight.set(r, Date.now());
      this.lastNetActivity = Date.now();
    };
    const onEnd = (r: Request) => {
      if (this.inflight.delete(r)) this.lastNetActivity = Date.now();
    };
    page.on('request', onStart);
    page.on('requestfinished', onEnd);
    page.on('requestfailed', onEnd);
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) {
        this.navCount++;
        this.inflight.clear();
        this.lastNetActivity = Date.now();
      }
    });
  }

  /** 把任务排进本标签页的串行队列 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // 队列只关心"上一个结束了没有"，不传播错误；
    // 即使某个动作卡死，最多占用队列 toolTimeout，之后自动释放，避免后续调用全部堵死
    const released = run.catch(() => undefined);
    this.chain = Promise.race([released, new Promise((r) => setTimeout(r, config.toolTimeout).unref())]);
    return run;
  }

  /** 进行中的请求数（忽略挂起超过 10s 的长轮询） */
  pendingRequests(): number {
    const cutoff = Date.now() - 10_000;
    let n = 0;
    for (const started of this.inflight.values()) if (started > cutoff) n++;
    return n;
  }

  /**
   * 等待 DOM 就绪（readyState 不再是 loading）。
   * 不用 waitForLoadState：从往返缓存(bfcache)恢复的页面不会再触发 load 事件，会白等到超时。
   */
  async waitDomReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.closed) {
      const state = await Promise.race([
        this.page.evaluate(() => document.readyState).catch(() => 'loading'),
        new Promise<string>((r) => setTimeout(() => r('loading'), 500)),
      ]);
      if (state !== 'loading') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * 确保所在窗口没有被最小化。
   * 最小化的窗口不会渲染，截图、等待元素"稳定"等依赖渲染帧的操作都会卡住直到超时。
   * 返回 true 表示窗口原本是最小化的、已被还原。
   */
  async ensureWindowShown(): Promise<boolean> {
    // 插件模式：后台标签页照样能操作（已实测），不抢用户焦点；截图失败时再用 bringIntoView()
    if (config.mode === 'extension') return false;
    try {
      if (!this.cdp) this.cdp = await this.page.context().newCDPSession(this.page);
      const { windowId, bounds } = (await this.cdp.send('Browser.getWindowForTarget')) as {
        windowId: number;
        bounds: { windowState?: string };
      };
      if (bounds.windowState === 'minimized') {
        await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await new Promise((r) => setTimeout(r, 300));
        return true;
      }
    } catch {
      this.cdp = null; // 会话失效时下次重建；检查失败不影响主流程
    }
    return false;
  }

  /** 插件模式：本标签页对应的 Chrome tabId */
  async extTabId(): Promise<number> {
    if (!this.cdp) this.cdp = await this.page.context().newCDPSession(this.page);
    const { tabId } = (await this.cdp.send('MCP.getTabId' as any)) as { tabId: number };
    return tabId;
  }

  /** 把标签页切到前台并还原最小化窗口（截图等依赖渲染的操作失败时使用） */
  async bringIntoView(): Promise<void> {
    if (config.mode === 'extension') {
      try {
        const { getRelay } = await import('../extension/relay.js');
        await getRelay().callExtension('ui.activate', [await this.extTabId()]);
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        this.cdp = null;
        log.debug('切换标签页到前台失败', e);
      }
    } else {
      await this.page.bringToFront().catch(() => undefined);
      await this.ensureWindowShown();
    }
  }

  get closed(): boolean {
    return this.page.isClosed();
  }

  async describe(): Promise<{ id: string; url: string; title: string }> {
    let title = '';
    try {
      title = await this.page.title();
    } catch {
      /* 页面可能正在导航 */
    }
    return { id: this.id, url: this.page.url(), title };
  }
}

export interface TabEvents {
  onOpened(tab: Tab, openedByActive: boolean): void;
  onClosed(tab: Tab): void;
}

/** 维护 Page <-> 短 ID 的映射和"当前标签页" */
export class TabManager {
  private tabs = new Map<Page, Tab>();
  private seq = 0;
  private activeTab: Tab | null = null;

  constructor(private events: TabEvents) {}

  register(page: Page, opts: { activate?: boolean; notify?: boolean } = {}): Tab {
    const existing = this.tabs.get(page);
    if (existing) return existing;
    const tab = new Tab(`t${++this.seq}`, page);
    this.tabs.set(page, tab);
    page.once('close', () => {
      this.tabs.delete(page);
      if (this.activeTab === tab) this.activeTab = this.lastOpen();
      log.info(`标签页关闭 ${tab.id}`);
      this.events.onClosed(tab);
    });
    if (opts.activate || !this.activeTab) this.activeTab = tab;
    log.info(`标签页登记 ${tab.id} ${page.url()}`);
    return tab;
  }

  /** context.on('page') 的处理：由当前标签页打开的新页面（弹窗/target=_blank）自动切换过去 */
  async handleNewPage(page: Page): Promise<void> {
    if (this.tabs.has(page)) return;
    let opener: Page | null = null;
    try {
      opener = await page.opener();
    } catch {
      opener = null;
    }
    const openedByActive = !!opener && opener === this.activeTab?.page;
    const tab = this.register(page, { activate: openedByActive });
    this.events.onOpened(tab, openedByActive);
  }

  get active(): Tab | null {
    if (this.activeTab && this.activeTab.closed) this.activeTab = this.lastOpen();
    return this.activeTab;
  }

  setActive(tab: Tab) {
    this.activeTab = tab;
  }

  byId(id: string): Tab | undefined {
    for (const t of this.tabs.values()) if (t.id === id) return t;
    return undefined;
  }

  byPage(page: Page): Tab | undefined {
    return this.tabs.get(page);
  }

  list(): Tab[] {
    return [...this.tabs.values()].filter((t) => !t.closed);
  }

  clear() {
    this.tabs.clear();
    this.activeTab = null;
  }

  private lastOpen(): Tab | null {
    const open = this.list();
    return open.length ? open[open.length - 1] : null;
  }
}
