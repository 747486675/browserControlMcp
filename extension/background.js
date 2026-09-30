// browser-mcp 插件后台（Manifest V3 service worker）
// 职责：连接本机 MCP 中转服务；只把"AI"分组里的标签页交给 AI 控制；转发 chrome.debugger 调用和事件；
//       危险动作弹窗确认；下载事件转发；暂停/恢复。
import { DEFAULT_PORT, DEFAULT_SENSITIVE, GROUP_TITLE, PROTOCOL_VERSION } from './defaults.js';

const state = {
  ws: null,
  ready: false, // 已发送 extension.initialized
  paused: false,
  aiTabs: new Set(), // AI 可控制的标签页
  attached: new Set(), // 已附加调试器的标签页
  lastActivity: 0, // 最近一次收到 MCP 指令的时间（用于判断下载是否由 AI 触发）
  backoff: 1000,
  reconnectTimer: null,
  pingTimer: null,
  lastError: '',
  trackedDownloads: new Set(),
  attachFailed: new Set(), // 附加调试器失败过的标签页（跳转到正常网址后重试）
  grouping: new Set(), // 正在由插件放入 AI 分组的标签页（新建分组时会先出现一个未命名分组，期间忽略分组变化事件）
  testAutoConfirm: null, // 仅自动化测试通过浏览器调试端口设置；没有任何 RPC 能修改它
};
const pendingConfirms = new Map(); // id -> { req, resolve, windowId, timer }
globalThis.__bmcp = state; // 便于在 chrome://extensions 的 service worker 控制台里排查（只读查看）

// ---------------- 设置 ----------------

async function settings() {
  const s = await chrome.storage.local.get(['port', 'token', 'paused', 'sensitive', 'trusted']);
  if (!s.token) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    s.token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await chrome.storage.local.set({ token: s.token });
  }
  return {
    port: Number(s.port) || DEFAULT_PORT,
    token: s.token,
    paused: !!s.paused,
    sensitive: Array.isArray(s.sensitive) ? s.sensitive : DEFAULT_SENSITIVE,
    trusted: Array.isArray(s.trusted) ? s.trusted : [],
  };
}

// ---------------- 连接 ----------------

let connecting = null;
function connect() {
  // 串行化：启动时 onInstalled/onStartup/alarm 可能同时触发
  if (!connecting) connecting = doConnect().finally(() => (connecting = null));
  return connecting;
}

async function doConnect() {
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(state.reconnectTimer);
  const s = await settings();
  state.paused = s.paused;
  // 先用 HTTP 探测端口，避免对未启动的 MCP 反复发起 WebSocket 而在扩展错误页刷屏
  try {
    await fetch(`http://127.0.0.1:${s.port}/`, { signal: AbortSignal.timeout(1500) });
  } catch {
    state.lastError = `MCP 未运行（127.0.0.1:${s.port}）`;
    scheduleReconnect();
    updateBadge();
    return;
  }
  const url = `ws://127.0.0.1:${s.port}/extension?v=${PROTOCOL_VERSION}&token=${encodeURIComponent(s.token)}&ext=${chrome.runtime.getManifest().version}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onmessage = (ev) => void onRpc(ev.data);
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    state.ready = false;
    clearInterval(state.pingTimer);
    if (ev.code === 4001) state.lastError = `连接被拒绝：${ev.reason}`;
    else if (!state.lastError) state.lastError = 'MCP 已断开';
    void detachAll();
    updateBadge();
    scheduleReconnect(ev.code === 4001 ? 30_000 : undefined);
  };
  // 等到连接建立或失败，保证 connect() 串行
  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('close', resolve, { once: true });
  });
  if (ws.readyState !== WebSocket.OPEN) return;
  state.backoff = 1000;
  state.lastError = '';
  clearInterval(state.pingTimer);
  // WebSocket 上的活动会让 service worker 保持存活（Chrome 116+）
  state.pingTimer = setInterval(() => send({ method: 'ping' }), 20_000);
  await sendInitial();
}

function scheduleReconnect(delay) {
  clearTimeout(state.reconnectTimer);
  const d = delay ?? state.backoff;
  state.backoff = Math.min(state.backoff * 2, 15_000);
  state.reconnectTimer = setTimeout(() => void connect(), d);
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function emit(method, params) {
  send({ method, params });
}

async function sendInitial() {
  await refreshAiTabs();
  if (!state.paused) {
    for (const id of state.aiTabs) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) emit('chrome.tabs.onCreated', [tab]);
    }
  }
  emit('extension.initialized', { paused: state.paused, version: chrome.runtime.getManifest().version });
  state.ready = true;
  updateBadge();
}

// ---------------- AI 分组 ----------------

async function aiGroupIds() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return new Set(groups.map((g) => g.id));
}

async function refreshAiTabs() {
  const ids = await aiGroupIds();
  const tabs = await chrome.tabs.query({});
  const next = new Set();
  for (const t of tabs) if (ids.has(t.groupId)) next.add(t.id);
  // 保留不在分组里但由 AI 打开的弹窗窗口里的标签页
  for (const id of state.aiTabs) if (!next.has(id) && tabs.some((t) => t.id === id && t.groupId === -1)) next.add(id);
  state.aiTabs = next;
}

async function targetWindowId() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  if (groups.length) return groups[0].windowId;
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w?.id !== undefined) return w.id;
  } catch {}
  const w = await chrome.windows.create({});
  return w.id;
}

async function addToAiGroup(tabId, windowId) {
  state.grouping.add(tabId);
  try {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId });
    if (groups.length) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    } else {
      const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: 'purple', collapsed: false });
    }
  } catch (e) {
    // 弹出式窗口里的标签页不能分组：仍然交给 AI，但不放进分组
    console.warn('加入 AI 分组失败', e);
  } finally {
    state.grouping.delete(tabId);
  }
}

function assertAi(tabId) {
  if (state.paused) throw new Error('PAUSED: AI 控制已被用户暂停');
  if (!state.aiTabs.has(tabId)) throw new Error(`标签页 ${tabId} 不在 AI 分组中，AI 无权控制`);
}

// ---------------- RPC ----------------

const RPC = {
  async 'chrome.tabs.create'(opts) {
    if (state.paused) throw new Error('PAUSED: AI 控制已被用户暂停');
    const windowId = await targetWindowId();
    const tab = await chrome.tabs.create({ windowId, url: opts?.url || 'about:blank', active: true });
    state.aiTabs.add(tab.id); // 先登记，避免分组变化事件重复上报
    await addToAiGroup(tab.id, windowId);
    updateBadge();
    return await chrome.tabs.get(tab.id);
  },
  async 'chrome.tabs.remove'(tabId) {
    assertAi(tabId);
    await chrome.tabs.remove(tabId);
  },
  async 'chrome.debugger.attach'(target, version) {
    assertAi(target.tabId);
    if (!state.attached.has(target.tabId)) {
      try {
        await chrome.debugger.attach({ tabId: target.tabId }, version || '1.3');
      } catch (e) {
        state.attachFailed.add(target.tabId);
        throw e;
      }
      state.attachFailed.delete(target.tabId);
      state.attached.add(target.tabId);
      updateBadge();
    }
  },
  async 'chrome.debugger.detach'(target) {
    if (state.attached.delete(target.tabId)) {
      await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
      updateBadge();
    }
  },
  async 'chrome.debugger.sendCommand'(target, method, params) {
    assertAi(target.tabId);
    return await chrome.debugger.sendCommand(target, method, params);
  },
  /** 让标签页可见（后台标签页和最小化窗口不渲染，点击/截图会卡住） */
  async 'ui.activate'(tabId) {
    assertAi(tabId);
    const tab = await chrome.tabs.get(tabId);
    let activated = false;
    let restored = false;
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      activated = true;
    }
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') {
      await chrome.windows.update(tab.windowId, { state: 'normal' });
      restored = true;
    }
    return { activated, restored };
  },
  async 'ui.confirm'(req) {
    return await confirmAction(req);
  },
  async 'policy.get'() {
    const s = await settings();
    return { sensitive: s.sensitive, trusted: s.trusted };
  },
  async 'policy.trust'(host) {
    const s = await settings();
    if (matchHost(host, s.sensitive)) return false;
    if (!s.trusted.includes(host)) await chrome.storage.local.set({ trusted: [...s.trusted, host] });
    return true;
  },
};

async function onRpc(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  state.lastActivity = Date.now();
  const fn = RPC[msg.method];
  if (!fn) {
    send({ id: msg.id, error: `method not allowed: ${msg.method}` });
    return;
  }
  try {
    const result = await fn(...(Array.isArray(msg.params) ? msg.params : [msg.params]));
    send({ id: msg.id, result });
  } catch (e) {
    send({ id: msg.id, error: e?.message || String(e) });
  }
}

// ---------------- 事件转发 ----------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !state.aiTabs.has(source.tabId)) return;
  emit('chrome.debugger.onEvent', [source, method, params]);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const was = state.attached.delete(source.tabId);
  if (was) emit('chrome.debugger.onDetach', [source, reason]);
  updateBadge();
  // 用户点了浏览器顶部提示条上的"取消"：视为要求停止 AI
  if (reason === 'canceled_by_user') void pause();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  // AI 标签页打开的新标签页/弹窗，自动交给 AI
  if (tab.openerTabId !== undefined && state.aiTabs.has(tab.openerTabId) && !state.aiTabs.has(tab.id)) {
    state.aiTabs.add(tab.id);
    await addToAiGroup(tab.id, tab.windowId);
    if (state.ready && !state.paused) emit('chrome.tabs.onCreated', [await chrome.tabs.get(tab.id).catch(() => tab)]);
    updateBadge();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  // AI 标签页（常见于 about:blank 弹窗）附加调试器失败时，跳转到正常网址后再报告一次，让 MCP 重试附加
  if (change.url && state.attachFailed.has(tabId) && state.aiTabs.has(tabId) && state.ready && !state.paused && /^https?:/.test(change.url)) {
    state.attachFailed.delete(tabId);
    emit('chrome.tabs.onCreated', [tab]);
  }
  if (!('groupId' in change)) return;
  if (state.grouping.has(tabId)) return; // 插件自己正在分组（分组可能还没命名为"AI"）
  const ids = await aiGroupIds();
  const inGroup = ids.has(change.groupId);
  if (inGroup && !state.aiTabs.has(tabId)) {
    // 用户把标签页拖进 AI 分组：交给 AI
    state.aiTabs.add(tabId);
    if (state.ready && !state.paused) emit('chrome.tabs.onCreated', [tab]);
  } else if (!inGroup && state.aiTabs.has(tabId)) {
    // 用户把标签页拖出 AI 分组（或拖进别的分组）：立即收回控制
    state.aiTabs.delete(tabId);
    if (state.attached.delete(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
    emit('chrome.tabs.onRemoved', [tabId]);
  }
  updateBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.attachFailed.delete(tabId);
  if (!state.aiTabs.delete(tabId)) return;
  state.attached.delete(tabId);
  emit('chrome.tabs.onRemoved', [tabId]);
  updateBadge();
});

// ---------------- 下载 ----------------

chrome.downloads.onCreated.addListener((item) => {
  if (!state.ready || state.paused || Date.now() - state.lastActivity > 15_000) return;
  state.trackedDownloads.add(item.id);
  emit('downloads.created', { id: item.id, url: item.finalUrl || item.url, filename: item.filename, state: item.state });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!state.trackedDownloads.has(delta.id)) return;
  if (!delta.state && !delta.filename) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  emit('downloads.changed', {
    id: item.id,
    url: item.finalUrl || item.url,
    filename: item.filename,
    state: item.state,
    fileSize: item.fileSize,
    error: item.error,
  });
  if (item.state !== 'in_progress') state.trackedDownloads.delete(item.id);
});

// ---------------- 暂停 / 恢复 ----------------

async function detachAll() {
  const ids = [...state.attached];
  state.attached.clear();
  await Promise.all(ids.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
  updateBadge();
}

async function pause() {
  if (state.paused) return;
  state.paused = true;
  await chrome.storage.local.set({ paused: true });
  await detachAll();
  emit('extension.paused', {});
  updateBadge();
}

async function resume() {
  if (!state.paused) return;
  state.paused = false;
  await chrome.storage.local.set({ paused: false });
  emit('extension.resumed', {});
  await refreshAiTabs();
  for (const id of state.aiTabs) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) emit('chrome.tabs.onCreated', [tab]);
  }
  updateBadge();
}

// ---------------- 确认弹窗 ----------------

async function confirmAction(req) {
  if (state.testAutoConfirm) {
    await appendAudit({ ...req, answer: `${state.testAutoConfirm}(test)` });
    return state.testAutoConfirm;
  }
  const id = crypto.randomUUID();
  const timeoutMs = Math.max(5_000, Math.min(Number(req.timeoutMs) || 45_000, 120_000));
  const answer = await new Promise(async (resolve) => {
    const entry = { req: { ...req, timeoutMs }, resolve, windowId: null, timer: null };
    pendingConfirms.set(id, entry);
    entry.timer = setTimeout(() => finishConfirm(id, 'deny', 'timeout'), timeoutMs);
    try {
      const win = await chrome.windows.create({
        url: `confirm.html?id=${encodeURIComponent(id)}`,
        type: 'popup',
        width: 480,
        height: 460,
        focused: true,
      });
      entry.windowId = win.id;
    } catch (e) {
      finishConfirm(id, 'deny', 'window-failed');
    }
  });
  await appendAudit({ ...req, answer });
  if (answer === 'trust') await RPC['policy.trust'](req.host);
  return answer;
}

function finishConfirm(id, answer, why) {
  const entry = pendingConfirms.get(id);
  if (!entry) return;
  pendingConfirms.delete(id);
  clearTimeout(entry.timer);
  if (entry.windowId !== null) chrome.windows.remove(entry.windowId).catch(() => {});
  entry.resolve(answer);
  if (why) console.info(`确认 ${id} -> ${answer} (${why})`);
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, e] of pendingConfirms) if (e.windowId === windowId) finishConfirm(id, 'deny', 'window-closed');
});

// ---------------- 审计 ----------------

async function appendAudit(entry) {
  const { audit = [] } = await chrome.storage.local.get('audit');
  audit.push({ time: new Date().toISOString(), ...entry });
  while (audit.length > 500) audit.shift();
  await chrome.storage.local.set({ audit });
}

function matchHost(host, list) {
  host = String(host || '').toLowerCase();
  return list.some((d) => {
    d = String(d).trim().toLowerCase();
    return d && (host === d || host.endsWith('.' + d));
  });
}

// ---------------- 图标徽标 ----------------

function updateBadge() {
  const connected = state.ws?.readyState === WebSocket.OPEN;
  let text = '';
  let color = '#9ca3af';
  let title = 'browser-mcp：未连接';
  if (state.paused) {
    text = '停';
    color = '#dc2626';
    title = 'browser-mcp：已暂停（点击图标恢复）';
  } else if (connected) {
    text = state.attached.size ? String(state.attached.size) : '';
    color = '#7c3aed';
    title = `browser-mcp：已连接，AI 正在控制 ${state.attached.size} 个标签页`;
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setTitle({ title }).catch(() => {});
}

// ---------------- 来自插件页面的消息 ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'wake': {
        if (msg.port && Number(msg.port) > 0) await chrome.storage.local.set({ port: Number(msg.port) });
        state.backoff = 1000;
        await connect();
        return { ok: true };
      }
      case 'status': {
        const s = await settings();
        await refreshAiTabs();
        return {
          connected: state.ws?.readyState === WebSocket.OPEN,
          paused: state.paused,
          port: s.port,
          aiTabs: state.aiTabs.size,
          attached: state.attached.size,
          lastError: state.lastError,
        };
      }
      case 'pause':
        await pause();
        return { ok: true };
      case 'resume':
        await resume();
        return { ok: true };
      case 'settings-changed':
        state.ws?.close();
        state.backoff = 1000;
        setTimeout(() => void connect(), 200);
        return { ok: true };
      case 'confirm-get': {
        const e = pendingConfirms.get(msg.id);
        return e ? { req: e.req } : { req: null };
      }
      case 'confirm-answer':
        finishConfirm(msg.id, ['allow', 'deny', 'trust'].includes(msg.answer) ? msg.answer : 'deny');
        return { ok: true };
      default:
        return { ok: false };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// 来自 MCP 唤醒页（http://127.0.0.1:<端口>/wake）的消息。
// 安全：外部消息只能触发"按已保存的端口重连"，不能修改端口或任何设置，
// 否则本机其他网页可以把插件引到假的服务上骗走配对令牌。
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'wake') {
    sendResponse({ ok: false });
    return;
  }
  state.backoff = 1000;
  void connect();
  sendResponse({ ok: true });
  // 顺手关掉唤醒页
  if (sender.tab?.id !== undefined && /\/wake(\?|$)/.test(sender.url || '')) {
    setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 500);
  }
});

// ---------------- 启动 ----------------

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive') void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
updateBadge();
void connect();
