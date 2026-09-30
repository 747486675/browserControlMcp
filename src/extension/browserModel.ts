/**
 * 把"插件能控制的标签页"伪装成一个 CDP 浏览器，供 Playwright connectOverCDP 使用。
 *
 * 移植自 Playwright（packages/playwright-core/src/tools/mcp/browserModel.ts），
 * Copyright (c) Microsoft Corporation, Apache License 2.0。
 * 在此基础上增加：tabId <-> targetId 映射、Target.attachToTarget 别名会话、重置会话。
 */
import { log } from '../log.js';

export type SendToExtension = (method: string, params: unknown[]) => Promise<any>;
export type CDPMessage = { id?: number; sessionId?: string; method?: string; params?: any; result?: any; error?: any };

interface TabSession {
  tabId: number;
  sessionId: string;
  targetInfo: any;
  /** chrome.debugger 自动附加的子会话（iframe、worker） */
  childSessions: Set<string>;
}

export class BrowserModel {
  private sendToCDPClient: ((m: CDPMessage) => void) | null = null;
  /** 插件报告的 AI 标签页（不一定已附加调试器） */
  private knownTabs = new Map<number, any>();
  private tabSessions = new Map<number, TabSession>();
  /** Target.attachToTarget 产生的别名会话 -> tabId */
  private aliasSessions = new Map<string, number>();
  private autoAttach = false;
  private nextSessionId = 1;

  constructor(
    private sendToExtension: SendToExtension,
    private onBlockedTabClosed: (url: string) => void = () => {},
  ) {}

  connectOverCDP(send: (m: CDPMessage) => void) {
    this.sendToCDPClient = send;
  }

  private emit(m: CDPMessage) {
    this.sendToCDPClient?.(m);
  }

  // ─── 插件 → 模型 ───
  onTabCreated(tab: any) {
    if (tab?.id === undefined) return;
    this.knownTabs.set(tab.id, tab);
    if (this.autoAttach) void this.attachTab(tab.id).catch((e) => log.warn(`附加标签页 ${tab.id} 失败`, e));
  }

  onTabRemoved(tabId: number) {
    this.knownTabs.delete(tabId);
    this.detachTab(tabId);
  }

  onDebuggerEvent(source: { tabId?: number; sessionId?: string }, method: string, params: any) {
    if (source.tabId === undefined) return;
    const ts = this.tabSessions.get(source.tabId);
    if (!ts) return;
    const child = params?.sessionId;
    if (method === 'Target.attachedToTarget' && child) ts.childSessions.add(child);
    else if (method === 'Target.detachedFromTarget' && child) ts.childSessions.delete(child);
    const sessionId = source.sessionId || ts.sessionId;
    this.emit({ sessionId, method, params });
  }

  onDebuggerDetach(source: { tabId?: number }) {
    if (source.tabId !== undefined) this.detachTab(source.tabId);
  }

  // ─── Playwright → 模型 ───
  async enableAutoAttach() {
    this.autoAttach = true;
    // 已存在的标签页可能停在残留的对话框上（渲染进程被阻塞），Playwright 初始化它时会一直挂起，先探测
    await Promise.all([...this.knownTabs.keys()].map((id) => this.attachTab(id, true).catch((e) => log.warn(`附加标签页 ${id} 失败`, e))));
  }

  async createTarget(url?: string) {
    const tab = await this.sendToExtension('chrome.tabs.create', [{ url: url || 'about:blank' }]);
    if (tab?.id === undefined) throw new Error('Failed to create tab');
    this.knownTabs.set(tab.id, tab);
    const ts = await this.attachTab(tab.id);
    return { targetId: ts.targetInfo?.targetId };
  }

  async closeTarget(targetId?: string) {
    const ts = targetId ? this.find((s) => s.targetInfo?.targetId === targetId) : undefined;
    if (!ts) return { success: false };
    await this.sendToExtension('chrome.tabs.remove', [ts.tabId]);
    return { success: true };
  }

  getTargetInfo(sessionId?: string) {
    if (!sessionId) return undefined;
    const tabId = this.tabIdForSession(sessionId);
    return tabId === undefined ? undefined : this.tabSessions.get(tabId)?.targetInfo;
  }

  /** Playwright 的 newCDPSession 会发 Target.attachToTarget：用别名会话指向同一个标签页 */
  attachToTarget(targetId: string) {
    const ts = this.find((s) => s.targetInfo?.targetId === targetId);
    if (!ts) throw new Error(`No target with given id found: ${targetId}`);
    const sessionId = `mcp-alias-${this.nextSessionId++}`;
    this.aliasSessions.set(sessionId, ts.tabId);
    return { sessionId };
  }

  detachFromTarget(sessionId?: string) {
    if (sessionId) this.aliasSessions.delete(sessionId);
    return {};
  }

  tabIdForSession(sessionId: string): number | undefined {
    const alias = this.aliasSessions.get(sessionId);
    if (alias !== undefined) return alias;
    return this.find((s) => s.sessionId === sessionId || s.childSessions.has(sessionId))?.tabId;
  }

  hasAttachedTabs(): boolean {
    return this.tabSessions.size > 0;
  }

  /** 浏览器级命令：chrome.debugger 必须指定目标，借用任一已附加的标签页转发 */
  async sendBrowserCommand(method: string, params: any) {
    const ts = this.tabSessions.values().next().value as TabSession | undefined;
    if (!ts) throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return this.sendToExtension('chrome.debugger.sendCommand', [{ tabId: ts.tabId }, method, params]);
  }

  async sendCommand(sessionId: string, method: string, params: any) {
    const aliasTab = this.aliasSessions.get(sessionId);
    if (aliasTab !== undefined) {
      return this.sendToExtension('chrome.debugger.sendCommand', [{ tabId: aliasTab }, method, params]);
    }
    let ts = this.find((s) => s.sessionId === sessionId);
    let cdpSessionId: string | undefined;
    if (!ts) {
      ts = this.find((s) => s.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!ts) throw new Error(`No tab found for sessionId: ${sessionId}`);
    return this.sendToExtension('chrome.debugger.sendCommand', [{ tabId: ts.tabId, sessionId: cdpSessionId }, method, params]);
  }

  /** Playwright 连接断开：让插件释放所有调试器，下次连接重新附加 */
  async reset() {
    this.sendToCDPClient = null;
    this.autoAttach = false;
    const ids = [...this.tabSessions.keys()];
    this.tabSessions.clear();
    this.aliasSessions.clear();
    await Promise.all(ids.map((tabId) => this.sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(() => undefined)));
  }

  /** 插件断开：所有状态作废 */
  clearAll() {
    this.knownTabs.clear();
    this.tabSessions.clear();
    this.aliasSessions.clear();
    this.autoAttach = false;
  }

  // ─── 内部 ───
  /** 正在进行中的附加，防止同一标签页被并发附加两次（会导致 Playwright 报 Duplicate target） */
  private attaching = new Map<number, Promise<TabSession>>();

  private attachTab(tabId: number, probe = false): Promise<TabSession> {
    const existing = this.tabSessions.get(tabId);
    if (existing) return Promise.resolve(existing);
    let p = this.attaching.get(tabId);
    if (!p) {
      p = this.doAttachTab(tabId, probe).finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, p);
    }
    return p;
  }

  private async doAttachTab(tabId: number, probe: boolean): Promise<TabSession> {
    await this.sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
    if (probe) {
      const alive = await Promise.race([
        this.sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Runtime.evaluate', { expression: '1' }]).then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), 1_500)),
      ]);
      if (!alive) {
        const url = this.knownTabs.get(tabId)?.url ?? '';
        log.warn(`AI 标签页 ${tabId} 无响应（可能停在对话框上），关闭它：${url}`);
        this.knownTabs.delete(tabId);
        await this.sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(() => undefined);
        await this.sendToExtension('chrome.tabs.remove', [tabId]).catch(() => undefined);
        this.onBlockedTabClosed(url);
        throw new Error('tab blocked');
      }
    }
    const res = await this.sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Target.getTargetInfo']);
    const targetInfo = res?.targetInfo;
    const ts: TabSession = { tabId, sessionId: `pw-tab-${this.nextSessionId++}`, targetInfo, childSessions: new Set() };
    this.tabSessions.set(tabId, ts);
    this.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: ts.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false },
    });
    return ts;
  }

  private detachTab(tabId: number) {
    const ts = this.tabSessions.get(tabId);
    if (!ts) return;
    this.tabSessions.delete(tabId);
    for (const [alias, t] of this.aliasSessions) if (t === tabId) this.aliasSessions.delete(alias);
    this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: ts.sessionId, targetId: ts.targetInfo?.targetId } });
  }

  private find(pred: (s: TabSession) => boolean): TabSession | undefined {
    for (const s of this.tabSessions.values()) if (pred(s)) return s;
    return undefined;
  }
}
