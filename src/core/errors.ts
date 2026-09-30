export type ErrorCode =
  | 'REF_STALE'
  | 'INVALID_ARGUMENT'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'TIMEOUT'
  | 'NAVIGATION_INTERRUPTED'
  | 'NAVIGATION_FAILED'
  | 'BROWSER_DISCONNECTED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'DIALOG_OPEN'
  | 'TAB_CLOSED'
  | 'NO_TAB'
  | 'EXTENSION_NOT_CONNECTED'
  | 'USER_PAUSED'
  | 'ACTION_DENIED'
  | 'UNKNOWN';

const HINTS: Record<ErrorCode, string> = {
  REF_STALE: '页面已变化，该 ref 对应的元素不存在了。请重新调用 snapshot 获取最新 ref。',
  INVALID_ARGUMENT: '请检查参数格式。',
  ELEMENT_NOT_INTERACTABLE: '元素当前不可操作（不可见、被禁用或被遮挡）。可先 snapshot 查看是否有弹窗/遮罩，或先滚动/等待后再试。',
  TIMEOUT: '操作超时。页面可能仍在加载，可调用 wait_for 或 snapshot 后再试。',
  NAVIGATION_INTERRUPTED: '操作过程中页面发生了跳转。请重新 snapshot 查看当前页面。',
  NAVIGATION_FAILED: '页面无法打开，请检查网址或网络。',
  BROWSER_DISCONNECTED: '与浏览器的连接断开了。下一次调用会自动重连，然后请重新 snapshot。',
  BROWSER_LAUNCH_FAILED: '无法启动或连接 Chrome。请检查 Chrome 路径，并确认该 profile 目录没有被一个未开调试端口的 Chrome 占用。',
  DIALOG_OPEN: '页面上有对话框（alert/confirm/prompt）等待处理，请先调用 handle_dialog。',
  TAB_CLOSED: '目标标签页已关闭。请用 tabs(action="list") 查看现有标签页。',
  NO_TAB: '没有可用的标签页。',
  EXTENSION_NOT_CONNECTED: '浏览器插件未连接。请确认 Chrome 已打开、插件已安装启用，然后重试。',
  USER_PAUSED: '用户在浏览器插件里暂停了 AI 控制。请告知用户，等用户点"恢复"后再继续。不要尝试绕过。',
  ACTION_DENIED: '用户拒绝了这个操作（或确认超时）。不要重试同一操作；请换一种方式，或先询问用户。',
  UNKNOWN: '发生未知错误，可重新 snapshot 后再试。',
};

export class ToolError extends Error {
  code: ErrorCode;
  hint: string;
  /** 可以安全重试的瞬时错误 */
  transient: boolean;
  /** 错误发生在动作真正发出之前（重试不会造成重复点击/提交） */
  beforeDispatch: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; transient?: boolean; beforeDispatch?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = opts.hint ?? HINTS[code];
    this.transient = opts.transient ?? false;
    this.beforeDispatch = opts.beforeDispatch ?? false;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

/** 从 Playwright 的 call log 中提取对 AI 有用的几行 */
function callLogSummary(msg: string): string {
  const lines = msg
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  const interesting = lines.filter((l) =>
    /not visible|not enabled|not stable|intercepts pointer events|outside of the viewport|detached|not editable|retrying/.test(l),
  );
  const pick = (interesting.length ? interesting : lines).slice(-3);
  return pick.join(' | ');
}

/** 把 Playwright / 协议层错误归类成标准错误码 */
export function normalizeError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const e = err as Error;
  const msg = String(e?.message ?? err);
  const name = e?.name ?? '';
  // 动作是否已经发出（Playwright 的 call log 里会出现 "performing ... action"）
  const dispatched = /performing \w+ action|click action done|fill action done/i.test(msg);

  if (/浏览器插件未连接|Extension (not connected|disconnected)|WebSocket closed/i.test(msg)) {
    return new ToolError('BROWSER_DISCONNECTED', firstLine(msg), { transient: true, beforeDispatch: true, cause: err });
  }
  if (/Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Connection closed|WebSocket is not open/i.test(msg)) {
    if (/Target page/i.test(msg) && !/browser has disconnected/i.test(msg)) {
      return new ToolError('TAB_CLOSED', firstLine(msg), { cause: err });
    }
    return new ToolError('BROWSER_DISCONNECTED', firstLine(msg), { transient: true, beforeDispatch: !dispatched, cause: err });
  }
  if (
    name !== 'TimeoutError' &&
    /Execution context was destroyed|Frame was detached|frame got detached|interrupted by another navigation|because of a navigation|most likely because of a navigation/i.test(msg) &&
    !/net::ERR/.test(msg)
  ) {
    return new ToolError('NAVIGATION_INTERRUPTED', firstLine(msg), { transient: true, beforeDispatch: !dispatched, cause: err });
  }
  if (/net::ERR_|NS_ERROR|Cannot navigate to invalid URL/i.test(msg)) {
    return new ToolError('NAVIGATION_FAILED', firstLine(msg), { cause: err });
  }
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg)) {
    const summary = callLogSummary(msg);
    if (/not visible|not enabled|not stable|intercepts pointer events|not editable|outside of the viewport/i.test(msg)) {
      // 可操作性等待本身就是重试循环，再整体重试只会让失败耗时翻倍
      return new ToolError('ELEMENT_NOT_INTERACTABLE', `${firstLine(msg)}${summary ? ` (${summary})` : ''}`, {
        transient: false,
        beforeDispatch: !dispatched,
        cause: err,
      });
    }
    return new ToolError('TIMEOUT', `${firstLine(msg)}${summary ? ` (${summary})` : ''}`, {
      transient: false,
      beforeDispatch: !dispatched,
      cause: err,
    });
  }
  if (/Element is not attached|element is detached|Node is detached/i.test(msg)) {
    return new ToolError('REF_STALE', firstLine(msg), { beforeDispatch: true, cause: err });
  }
  return new ToolError('UNKNOWN', firstLine(msg), { cause: err });
}
