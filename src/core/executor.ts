import { config } from '../config.js';
import { log } from '../log.js';
import { session, type PendingDialog } from '../browser/session.js';
import { takeSnapshot } from '../browser/snapshot.js';
import type { Tab } from '../browser/tabs.js';
import { ToolError, normalizeError } from './errors.js';

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface RunOptions {
  /** 工具名（日志用） */
  name: string;
  /** 在当前标签页的串行队列里执行（默认 true） */
  tabScoped?: boolean;
  /** 幂等操作：瞬时错误时可放心重试 */
  idempotent?: boolean;
  /** 动作后等待页面平静（默认 true） */
  settle?: boolean;
  /** 结果末尾附上最新快照（默认 false） */
  snapshotAfter?: boolean;
  /** 有待处理对话框时也允许执行 */
  allowWithDialog?: boolean;
}

export interface ActionContext {
  tab: Tab;
}

export interface ActionOutput {
  text?: string;
  images?: { data: string; mimeType: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DialogInterrupt {
  constructor(public dialog: PendingDialog) {}
}

/**
 * 统一执行流水线：
 *   确保连接 → 检查对话框 → 取当前标签页 → 串行排队 →
 *   执行动作（与"对话框出现"赛跑）→ 等待页面平静 → 汇总事件 → 可选附带快照
 * 每一次调用都有总超时，任何错误都转换成带下一步建议的标准错误。
 */
export async function run(opts: RunOptions, action: (ctx: ActionContext) => Promise<ActionOutput | void>): Promise<ToolResult> {
  const started = Date.now();
  const o = { tabScoped: true, idempotent: false, settle: true, snapshotAfter: false, allowWithDialog: false, ...opts };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError('TIMEOUT', `工具 ${o.name} 超过总时限 ${config.toolTimeout}ms`, { hint: '浏览器可能卡住了。可调用 browser_status 或 screenshot 查看状态。' })),
      config.toolTimeout,
    );
  });
  try {
    const result = await Promise.race([execute(o, action), timeout]);
    log.info(`✓ ${o.name} ${Date.now() - started}ms`);
    return result;
  } catch (e) {
    const te = normalizeError(e);
    log.warn(`✗ ${o.name} ${te.code} ${te.message} (${Date.now() - started}ms)`);
    return errorResult(te);
  } finally {
    clearTimeout(timer);
  }
}

async function execute(o: Required<RunOptions>, action: (ctx: ActionContext) => Promise<ActionOutput | void>): Promise<ToolResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptOnce(o, action);
    } catch (e) {
      let te = normalizeError(e);
      if ((te.code === 'TAB_CLOSED' || te.code === 'BROWSER_DISCONNECTED') && attempt === 0) {
        // 浏览器刚被关掉时，Playwright 可能还没收到断开事件；稍等再确认
        await sleep(300);
        if (!session.connected) {
          te = new ToolError('BROWSER_DISCONNECTED', te.message, { transient: true, beforeDispatch: true, cause: e });
        }
      }
      const retryable = te.transient && (o.idempotent || te.beforeDispatch);
      if (attempt === 0 && retryable) {
        log.info(`重试 ${o.name}：${te.code}`);
        await sleep(te.code === 'BROWSER_DISCONNECTED' ? 500 : 300);
        continue;
      }
      throw te;
    }
  }
}

async function attemptOnce(o: Required<RunOptions>, action: (ctx: ActionContext) => Promise<ActionOutput | void>): Promise<ToolResult> {
  await session.ensure();

  const pending = session.activeDialog();
  if (pending && !o.allowWithDialog) {
    const d = pending;
    throw new ToolError('DIALOG_OPEN', `页面上有未处理的 ${d.type} 对话框：「${d.message}」`);
  }

  if (!o.tabScoped) {
    const out = (await action({ tab: undefined as unknown as Tab })) || {};
    return buildResult(o, out, undefined, false);
  }

  const tab = await session.activeTab();
  return tab.enqueue(async () => {
    if (tab.closed) throw new ToolError('TAB_CLOSED', `标签页 ${tab.id} 已关闭`, { beforeDispatch: true, transient: true });
    if (await tab.ensureWindowShown()) session.pushEvent('浏览器窗口处于最小化状态（不会渲染，操作会卡住），已自动还原。');
    const navBefore = tab.navCount;
    const dialogWatch = session.waitForDialog();
    let out: ActionOutput | void;
    let interruptedBy: PendingDialog | null = null;
    try {
      const actionPromise = action({ tab });
      const res = await Promise.race([actionPromise, dialogWatch.promise.then((d) => new DialogInterrupt(d))]);
      if (res instanceof DialogInterrupt) {
        // 动作触发了对话框：动作本身会一直阻塞到对话框被处理，这里先返回，让 AI 调用 handle_dialog
        interruptedBy = res.dialog;
        actionPromise.catch((e) => log.debug('对话框期间的动作结束', e));
        out = {};
      } else {
        out = res;
      }
      log.debug(`${o.name}: 动作完成${interruptedBy ? '（被对话框打断）' : ''}`);
    } finally {
      dialogWatch.cancel();
    }

    if (interruptedBy) {
      return buildResult(
        o,
        { text: `${out?.text ?? '动作已执行'}\n⚠ 页面弹出了 ${interruptedBy.type} 对话框：「${interruptedBy.message}」。请调用 handle_dialog 处理（accept 确认 / dismiss 取消）。` },
        undefined,
        false,
      );
    }

    if (o.settle) await settle(tab, navBefore);
    log.debug(`${o.name}: settle 完成`);
    const navigated = tab.navCount !== navBefore;
    return buildResult(o, out || {}, tab, navigated);
  });
}

/**
 * 等待页面平静：
 * - 动作结束后至少观察 settleQuiet 毫秒（捕获"点击后稍晚才发起"的请求或跳转）；
 * - 期间若发生跳转，等待 DOMContentLoaded；
 * - 网络空闲 settleQuiet 毫秒即返回；总时长不超过 settleMax。
 */
async function settle(tab: Tab, navBefore: number): Promise<void> {
  const actionEnd = Date.now();
  const deadline = actionEnd + config.settleMax;
  let navSeen = navBefore;
  while (Date.now() < deadline) {
    if (tab.closed || session.pendingDialog) return;
    if (tab.navCount !== navSeen) {
      navSeen = tab.navCount;
      await tab.waitDomReady(Math.max(1, deadline - Date.now()));
      continue;
    }
    const quietSince = Math.max(tab.lastNetActivity, actionEnd);
    if (tab.pendingRequests() === 0 && Date.now() - quietSince >= config.settleQuiet) return;
    await sleep(50);
  }
}

async function buildResult(o: Required<RunOptions>, out: ActionOutput, tab: Tab | undefined, navigated: boolean): Promise<ToolResult> {
  const parts: string[] = [];
  if (out.text) parts.push(out.text);

  let snap: string | null = null;
  let snapNote = '';
  if (o.snapshotAfter && !session.activeDialog()) {
    // 动作可能打开了新标签页并自动切换，快照取"当前"标签页
    const current = session.tabs.active ?? tab;
    if (current && !current.closed) {
      // 快照期间如果弹出对话框，页面会被阻塞，快照也会卡住，所以同样要与"对话框出现"赛跑
      const watch = session.waitForDialog();
      const snapPromise = takeSnapshot(current);
      try {
        const res = await Promise.race([snapPromise, watch.promise.then(() => null)]);
        if (res === null) snapPromise.catch(() => undefined);
        snap = res;
      } catch (e) {
        snapNote = `（快照获取失败：${normalizeError(e).message}。可稍后调用 snapshot）`;
      } finally {
        watch.cancel();
      }
    }
  }

  const events = [...session.drainEvents(), ...session.collectDownloadEvents()];
  if (navigated && tab) events.unshift(`页面已跳转到：${tab.page.url()}`);
  const pd = session.activeDialog();
  if (pd && !parts.some((p) => p.includes('handle_dialog'))) {
    events.push(`⚠ 页面弹出了 ${pd.type} 对话框：「${pd.message}」，请调用 handle_dialog 处理（accept 确认 / dismiss 取消）。`);
  }
  if (events.length) parts.push(`事件：\n${events.map((e) => `- ${e}`).join('\n')}`);
  if (snap) parts.push(`当前页面快照：\n${snap}`);
  if (snapNote) parts.push(snapNote);

  const content: Content[] = [{ type: 'text', text: parts.join('\n\n') || 'OK' }];
  for (const img of out.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content };
}

function errorResult(te: ToolError): ToolResult {
  const events = [...session.drainEvents(), ...session.collectDownloadEvents()];
  let text = `错误 [${te.code}]：${te.message}\n建议：${te.hint}`;
  if (events.length) text += `\n\n事件：\n${events.map((e) => `- ${e}`).join('\n')}`;
  return { content: [{ type: 'text', text }], isError: true };
}
