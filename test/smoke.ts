/**
 * 端到端回归：以真实 MCP 客户端的方式（stdio）启动 dist/index.js，逐项验证稳定性场景。
 * 用法：npm run smoke
 * 环境变量：
 *   SMOKE_PORT       调试端口（默认 9444，避免和日常使用的 9222 冲突）
 *   SMOKE_PROFILE    测试用 profile 目录（默认系统临时目录）
 *   BROWSER_MCP_HEADLESS=1  无界面运行（CI/服务器）
 *   BROWSER_MCP_MODE=extension  插件模式：由测试启动加载了插件的 Chromium（需要有界面，Linux 用 xvfb-run）
 *   SMOKE_CHROME     插件模式下使用的浏览器（Chrome 137+ 正式版不支持 --load-extension，请用 Chromium/Chrome for Testing）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findChrome } from '../src/config.js';
import { startServer } from './server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SMOKE_PORT || 9444);
const profile = process.env.SMOKE_PROFILE || join(tmpdir(), 'browser-mcp-smoke-profile');
const EXT = process.env.BROWSER_MCP_MODE === 'extension';
const EXT_ID = 'chflgcopcgkalmdjfooaebbodljockfd';
const extDir = join(root, 'extension');
const chrome = process.env.SMOKE_CHROME || findChrome() || '';
const tokenFile = join(tmpdir(), 'browser-mcp-smoke-ext-token');
/** 插件模式下测试浏览器的启动参数（唤醒/重启时 MCP 也会用同样的参数） */
const extBrowserArgs = [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--load-extension=${extDir}`,
  `--disable-extensions-except=${extDir}`,
];

function launchExtBrowser() {
  const args = [...extBrowserArgs, ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'];
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
}

/** 在插件后台（service worker）里执行一段表达式，用于测试时查看/调整插件状态 */
async function swEval(expression: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => [])) as any[];
    const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (sw) return cdpOnce(sw.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('找不到插件 service worker');
}

/** 在一个新开的普通标签页（不属于 AI 分组）里打开网址，模拟用户自己的标签页 */
async function openUserTab(url: string): Promise<{ id: string; eval: (expr: string) => Promise<any> }> {
  const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const { targetId } = await cdpOnce(v.webSocketDebuggerUrl, 'Target.createTarget', { url });
  await new Promise((r) => setTimeout(r, 800));
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  const t = list.find((x) => x.id === targetId);
  return {
    id: targetId,
    eval: (expr: string) => cdpOnce(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value),
  };
}

function cdpOnce(wsUrl: string, method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${method} 超时`));
    }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) {
        clearTimeout(timer);
        ws.close();
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

type Result = { text: string; isError: boolean; images: number };
let client: Client;
let makeClientRef: () => Promise<Client>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!r.isError, images: r.content.filter((c) => c.type === 'image').length };
}

function ref(text: string, role: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`${role} "${esc}"[^\\n]*?\\[ref=(\\w+)\\]`));
  if (!m) throw new Error(`快照中找不到 ${role} "${name}"：\n${text.slice(0, 1500)}`);
  return m[1];
}

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    process.stderr.write(`  ✓ ${name} (${Date.now() - t0}ms)\n`);
  } catch (e) {
    failures.push(name);
    process.stderr.write(`  ✗ ${name}\n    ${(e as Error).message.replace(/\n/g, '\n    ')}\n`);
  }
}
function expect(cond: unknown, msg: string, detail = '') {
  if (!cond) throw new Error(`${msg}${detail ? `\n--- 输出 ---\n${detail.slice(0, 2000)}` : ''}`);
}

async function killBrowser() {
  let v: { webSocketDebuggerUrl: string };
  try {
    v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as typeof v;
  } catch {
    return; // 浏览器本来就没在运行
  }
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
    setTimeout(resolve, 3000);
  });
  // 等端口真正关闭
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      return;
    }
  }
}

/** 用 CDP 把测试浏览器窗口最小化 */
async function minimizeWindow() {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; id: string }[];
  const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const target = list.find((t) => t.type === 'page')!;
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const my = ++id;
      ws.addEventListener('message', function h(ev) {
        const m = JSON.parse(String(ev.data));
        if (m.id === my) {
          ws.removeEventListener('message', h);
          resolve(m.result);
        }
      });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  const { windowId } = await send('Browser.getWindowForTarget', { targetId: target.id });
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  ws.close();
  await new Promise((r) => setTimeout(r, 500));
}

async function main() {
  // 先关掉上次异常退出残留的测试浏览器，再清理 profile（Windows 上文件被占用时无法删除）
  await killBrowser().catch(() => undefined);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    process.stderr.write(`（清理测试 profile 失败，沿用旧目录：${(e as Error).message}）\n`);
  }
  const srv = await startServer();
  const U = (p: string) => `${srv.url}/${p}`;
  const downloadDir = join(profile, 'downloads');

  if (EXT) {
    if (!chrome) throw new Error('插件模式需要 SMOKE_CHROME 指向 Chromium');
    rmSync(tokenFile, { force: true });
    launchExtBrowser();
  }
  const makeClient = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'dist', 'index.js')],
      env: {
        ...(process.env as Record<string, string>),
        BROWSER_MCP_PORT: String(port),
        BROWSER_MCP_PROFILE: profile,
        BROWSER_MCP_DIALOG_TIMEOUT: '4000',
        ...(EXT
          ? {
              BROWSER_MCP_MODE: 'extension',
              BROWSER_MCP_EXT_TOKEN_FILE: tokenFile,
              BROWSER_MCP_CHROME: chrome,
              BROWSER_MCP_ARGS: extBrowserArgs.join(' '),
            }
          : {}),
      },
      stderr: 'ignore',
    });
    const c = new Client({ name: 'smoke', version: '0.0.0' });
    await c.connect(transport);
    return c;
  };
  const startClient = async () => {
    client = await makeClient();
  };
  makeClientRef = makeClient;
  await startClient();
  // 通用回归不测安全确认（有专项测试），测试页面里有"Confirm"之类的按钮，让插件自动允许
  if (EXT) await swEval(`(__bmcp.testAutoConfirm='allow', true)`);
  process.stderr.write(`browser-mcp smoke  mode=${EXT ? 'extension' : 'cdp'} port=${port} profile=${profile}\n`);

  await test('列出工具', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['navigate', 'snapshot', 'click', 'type', 'tabs', 'handle_dialog', 'wait_for_download']) expect(names.includes(n), `缺少工具 ${n}`);
  });

  await test('自动启动浏览器 + 状态', async () => {
    const r = await call('browser_status');
    expect(!r.isError && r.text.includes('已连接'), 'browser_status 未连接', r.text);
  });

  await test('延迟可用 + 位置移动的按钮能点上', async () => {
    const r = await call('navigate', { url: U('delayed.html') });
    const b = ref(r.text, 'button', 'Late Button');
    const c = await call('click', { ref: b });
    expect(!c.isError && c.text.includes('clicked 1'), '点击后没有看到 clicked 1', c.text);
  });

  await test('页面重渲染后旧 ref 返回 REF_STALE（不会误点）', async () => {
    const r = await call('navigate', { url: U('rerender.html') });
    const alpha = ref(r.text, 'button', 'Alpha');
    const re = await call('click', { ref: ref(r.text, 'button', 'Rerender') });
    const stale = await call('click', { ref: alpha });
    expect(stale.isError && stale.text.includes('REF_STALE'), '应返回 REF_STALE', stale.text);
    const fresh = await call('click', { ref: ref(re.text, 'button', 'Beta') });
    expect(fresh.text.includes('Beta gen2'), '用新 ref 应点中 Beta gen2', fresh.text);
  });

  await test('target=_blank 新标签页被识别并自动切换', async () => {
    const r = await call('navigate', { url: U('popup.html') });
    const c = await call('click', { ref: ref(r.text, 'link', 'Open Target') });
    expect(/新标签页 t\d+ 已打开/.test(c.text), '没有报告新标签页事件', c.text);
    expect(c.text.includes('Target Heading'), '快照应来自新标签页', c.text);
    const c2 = await call('click', { ref: ref(c.text, 'button', 'Target Button') });
    expect(c2.text.includes('Target Clicked'), '新标签页里的点击未生效', c2.text);
    const closed = await call('tabs', { action: 'close' });
    expect(!closed.isError, '关闭标签页失败', closed.text);
  });

  await test('window.open 弹窗被识别', async () => {
    const r = await call('navigate', { url: U('popup.html') });
    const c = await call('click', { ref: ref(r.text, 'button', 'Window Open') });
    expect(c.text.includes('Target Heading'), 'window.open 的新页未被切换', c.text);
    await call('tabs', { action: 'close' });
    const list = await call('tabs', { action: 'list' });
    expect(list.text.includes('popup.html'), '关闭后应回到 popup 页', list.text);
  });

  await test('先开空白弹窗再跳转：最终能控制弹窗', async () => {
    const r = await call('navigate', { url: U('popup.html') });
    await call('click', { ref: ref(r.text, 'button', 'Blank Then Nav') });
    let ok = false;
    let last = '';
    for (let i = 0; i < 12 && !ok; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const list = await call('tabs', { action: 'list' });
      last = list.text;
      const m = list.text.match(/(t\d+)\s+Target Page\s+\S*target\.html\?late/);
      if (m) {
        await call('tabs', { action: 'select', id: m[1] });
        const s = await call('snapshot');
        ok = s.text.includes('Target Heading');
        last = s.text;
      }
    }
    expect(ok, '跳转后的弹窗应可被控制', last);
    await call('tabs', { action: 'close' });
  });

  await test('alert 不会卡死，handle_dialog 可处理', async () => {
    const r = await call('navigate', { url: U('dialog.html') });
    const c = await call('click', { ref: ref(r.text, 'button', 'Alert') });
    expect(c.text.includes('hello alert') && c.text.includes('handle_dialog'), '应提示有 alert', c.text);
    const blocked = await call('snapshot');
    expect(blocked.isError && blocked.text.includes('DIALOG_OPEN'), '有对话框时应返回 DIALOG_OPEN', blocked.text);
    const h = await call('handle_dialog', { accept: true });
    expect(!h.isError, 'handle_dialog 失败', h.text);
    const s = await call('snapshot');
    expect(!s.isError, '处理后应可继续操作', s.text);
  });

  await test('confirm 取消 / prompt 输入', async () => {
    const r = await call('snapshot');
    await call('click', { ref: ref(r.text, 'button', 'Confirm') });
    const h = await call('handle_dialog', { accept: false });
    expect(h.text.includes('cancelled'), 'confirm 取消后应显示 cancelled', h.text);
    const r2 = await call('snapshot');
    await call('click', { ref: ref(r2.text, 'button', 'Prompt') });
    const h2 = await call('handle_dialog', { accept: true, promptText: 'Claude' });
    expect(h2.text.includes('prompt:Claude'), 'prompt 输入未生效', h2.text);
  });

  await test('延迟出现的 alert 在结果中被报告', async () => {
    const r = await call('snapshot');
    const c = await call('click', { ref: ref(r.text, 'button', 'Late Alert') });
    // 对话框在点击后 300ms 才弹出，可能晚于动作返回；此时应在后续调用里被报告
    let seen = c.text.includes('late alert');
    for (let i = 0; !seen && i < 10; i++) {
      await new Promise((res) => setTimeout(res, 200));
      seen = (await call('browser_status')).text.includes('late alert');
    }
    expect(seen, '没有检测到延迟 alert', c.text);
    await call('handle_dialog', { accept: true });
  });

  await test('未处理的对话框超时自动关闭', async () => {
    const r = await call('snapshot');
    await call('click', { ref: ref(r.text, 'button', 'Alert') });
    await new Promise((res) => setTimeout(res, 4500));
    const s = await call('snapshot');
    expect(!s.isError && s.text.includes('自动关闭'), '对话框应被自动关闭并报告', s.text);
  });

  await test('下载文件落盘', async () => {
    const r = await call('navigate', { url: U('download.html') });
    await call('click', { ref: ref(r.text, 'link', 'Download Report') });
    const d = await call('wait_for_download', { timeout: 15000 });
    const m = d.text.match(/下载完成：(.+?)（/);
    expect(m, '没有报告下载完成', d.text);
    const p = m![1];
    expect(existsSync(p) && (EXT || p.startsWith(downloadDir)), `文件不存在或不在下载目录 ${downloadDir}`, d.text);
    expect(readFileSync(p, 'utf8').includes('hello from browser-mcp'), '文件内容不对');
  });

  await test('慢速下载：wait_for_download 会等到完成', async () => {
    const r = await call('snapshot');
    await call('click', { ref: ref(r.text, 'link', 'Download Slow') });
    const d = await call('wait_for_download', { timeout: 15000 });
    expect(/slow( \(\d+\))?\.bin/.test(d.text) && d.text.includes('下载完成'), '慢速下载未完成', d.text);
  });

  await test('临时遮罩：等待遮罩消失后点击成功', async () => {
    const r = await call('navigate', { url: U('overlay.html') });
    const c = await call('click', { ref: ref(r.text, 'button', 'Under Temp Mask') });
    expect(c.text.includes('A clicked'), '临时遮罩后应点击成功', c.text);
  });

  await test('永久遮挡：返回 ELEMENT_NOT_INTERACTABLE 而不是挂起', async () => {
    const r = await call('snapshot');
    const t0 = Date.now();
    const c = await call('click', { ref: ref(r.text, 'button', 'Under Permanent Mask') });
    expect(c.isError && /ELEMENT_NOT_INTERACTABLE|TIMEOUT/.test(c.text), '应返回不可操作错误', c.text);
    expect(Date.now() - t0 < 30_000, '耗时过长');
  });

  await test('表单：fill / select / 逐字输入 / 回车提交', async () => {
    const r = await call('navigate', { url: U('form.html') });
    await call('type', { ref: ref(r.text, 'textbox', 'Name'), text: '张三' });
    await call('select_option', { ref: ref(r.text, 'combobox', 'City'), values: ['Shanghai'] });
    const add = await call('click', { ref: ref(r.text, 'button', 'Add') });
    expect(add.text.includes('echo:张三/sh') && add.text.includes('count 1'), '表单值或异步更新不对（settle 未等到请求结束？）', add.text);
    const slow = await call('type', { ref: ref(r.text, 'textbox', 'Search'), text: 'abc', slowly: true });
    expect(/keys [34]\b/.test(slow.text) && slow.text.includes('text: abc'), '逐字输入应逐键触发 keydown', slow.text);
    const sub = await call('type', { ref: ref(r.text, 'textbox', 'Name'), text: 'go', submit: true });
    expect(sub.text.includes('submitted:go'), '回车提交未生效', sub.text);
  });

  await test('iframe 内元素可操作', async () => {
    const r = await call('navigate', { url: U('iframe.html') });
    const c = await call('click', { ref: ref(r.text, 'button', 'Frame Button') });
    expect(c.text.includes('Frame Clicked'), 'iframe 内点击未生效', c.text);
  });

  await test('点击后延迟跳转被报告', async () => {
    const r = await call('navigate', { url: U('nav.html') });
    const c = await call('click', { ref: ref(r.text, 'button', 'Go Later') });
    let ok = c.text.includes('页面已跳转') && c.text.includes('Target Heading');
    if (!ok) ok = (await call('snapshot')).text.includes('Target Heading');
    expect(ok, '跳转未被检测', c.text);
    const back = await call('go_back');
    expect(back.text.includes('nav.html'), '后退失败', back.text);
  });

  await test('并发调用被串行执行、不交错', async () => {
    const r = await call('navigate', { url: U('form.html') });
    const add = ref(r.text, 'button', 'Add');
    const results = await Promise.all(Array.from({ length: 5 }, () => call('click', { ref: add })));
    expect(results.every((x) => !x.isError), '并发点击有失败', results.map((x) => x.text).join('\n---\n'));
    const s = await call('snapshot');
    expect(s.text.includes('count 5'), '并发 5 次点击后应为 count 5', s.text);
  });

  await test('连续 50 次 输入+点击 无错误', async () => {
    const r = await call('navigate', { url: U('form.html') });
    const name = ref(r.text, 'textbox', 'Name');
    const add = ref(r.text, 'button', 'Add');
    for (let i = 1; i <= 50; i++) {
      const t = await call('type', { ref: name, text: `n${i}` });
      expect(!t.isError, `第 ${i} 次输入失败`, t.text);
      const c = await call('click', { ref: add });
      expect(!c.isError && c.text.includes(`count ${i}`), `第 ${i} 次点击结果不对`, c.text);
    }
  });

  await test('窗口被最小化时自动还原', async () => {
    if (process.env.BROWSER_MCP_HEADLESS === '1' || EXT) return; // 无界面模式没有窗口；插件模式不抢焦点，截图失败时才切前台
    await minimizeWindow();
    const s = await call('screenshot');
    expect(!s.isError && s.images === 1, '最小化后截图失败', s.text);
    expect(s.text.includes('最小化'), '应报告已还原最小化窗口', s.text);
  });

  await test('大页面：navigate 不带快照 + find 定位并点击', async () => {
    const r = await call('navigate', { url: U('bigtable.html'), snapshot: false });
    expect(!r.isError && !r.text.includes('当前页面快照') && r.text.length < 2000, 'snapshot=false 不应附带快照', r.text.slice(0, 500));
    const f = await call('find', { text: '预订 T257' });
    const m = f.text.match(/\[ref=(\w+)\]/);
    expect(m && f.text.includes('T257'), 'find 应返回带 ref 的匹配项', f.text);
    const c = await call('click', { ref: m![1] });
    expect(!c.isError && c.text.includes('booked T257'), '通过 find 的 ref 应能点击', c.text.slice(0, 500));
  });

  await test('大页面：read_text 分段读完整张表', async () => {
    const first = await call('read_text', { maxChars: 5000 });
    expect(first.text.includes('T000') && first.text.includes('offset='), '第一段应包含开头并提示 offset', first.text.slice(-300));
    const off = Number(first.text.match(/offset=(\d+)/)![1]);
    let all = first.text;
    let next = off;
    for (let i = 0; i < 20 && next; i++) {
      const r = await call('read_text', { offset: next, maxChars: 5000 });
      all += r.text;
      const m = r.text.match(/offset=(\d+)/);
      next = m ? Number(m[1]) : 0;
    }
    expect(all.includes('T299'), '分段读取应能读到最后一行', all.slice(-300));
  });

  await test('大页面：局部快照（ref）和层级限制（depth）', async () => {
    const f = await call('find', { text: 'table' });
    const m = f.text.match(/table[^\n]*\[ref=(\w+)\]/);
    expect(m, 'find 应找到表格', f.text);
    const part = await call('snapshot', { ref: m![1], depth: 1 });
    expect(!part.isError && part.text.includes('局部快照') && part.text.length < 2_000, '局部快照（depth=1）应很小', part.text.slice(0, 300));
    const shallow = await call('snapshot', { depth: 2 });
    expect(!shallow.isError && shallow.text.length < 5_000, 'depth=2 的快照应很短', String(shallow.text.length));
  });

  await test('截图', async () => {
    const s = await call('screenshot');
    expect(!s.isError && s.images === 1, '截图失败', s.text);
  });

  if (EXT) await extensionTests(U);

  await test('MCP 重启时页面停在对话框上，仍能连接', async () => {
    const r = await call('navigate', { url: U('dialog.html') });
    await call('click', { ref: ref(r.text, 'button', 'Alert') });
    await client.close(); // 模拟 MCP 进程退出，对话框留在浏览器里
    await startClient();
    const s = await call('snapshot');
    expect(!s.isError, '重启后应能正常快照', s.text);
    expect(s.text.includes('残留的对话框') && s.text.includes('dialog.html'), '应报告关闭了卡死页面及其网址', s.text);
  });

  await test('浏览器被关闭后自动重连', async () => {
    await killBrowser();
    const r = await call('navigate', { url: U('target.html') });
    expect(!r.isError && r.text.includes('Target Heading'), '重连后导航失败', r.text);
    expect(r.text.includes('自动重连'), '应提示已自动重连', r.text);
  });

  await test('错误网址返回 NAVIGATION_FAILED', async () => {
    const r = await call('navigate', { url: 'http://127.0.0.1:1/' });
    expect(r.isError && r.text.includes('NAVIGATION_FAILED'), '应返回 NAVIGATION_FAILED', r.text);
  });

  await client.close();
  srv.close();
  if (EXT) rmSync(tokenFile, { force: true });
  // 关闭测试浏览器
  await killBrowser().catch(() => undefined);

  process.stderr.write(`\n通过 ${passed} 项，失败 ${failures.length} 项${failures.length ? '：' + failures.join('、') : ''}\n`);
  process.exit(failures.length ? 1 : 0);
}

/** 插件模式专项测试 */
async function extensionTests(U: (p: string) => string) {
  await test('插件：AI 看不到分组外的用户标签页', async () => {
    const user = await openUserTab(U('target.html') + '?user');
    await new Promise((r) => setTimeout(r, 500));
    const list = await call('tabs', { action: 'list' });
    expect(!list.text.includes('target.html?user'), '分组外的标签页不应出现在 AI 的标签页列表里', list.text);
    await cdpOnce(
      ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any).webSocketDebuggerUrl,
      'Target.closeTarget',
      { targetId: user.id },
    );
  });

  await test('插件：AI 标签页都在"AI"分组里', async () => {
    await call('navigate', { url: U('target.html') });
    const groups = await swEval(`chrome.tabGroups.query({title:'AI'}).then(g=>g.length)`);
    const inGroup = await swEval(`chrome.tabGroups.query({title:'AI'}).then(async g=>g.length?(await chrome.tabs.query({groupId:g[0].id})).map(t=>t.url):[])`);
    expect(groups >= 1 && inGroup.some((u: string) => u.includes('target.html')), 'AI 标签页不在 AI 分组中', JSON.stringify(inGroup));
  });

  await test('插件：危险动作被用户拒绝 → ACTION_DENIED，且动作未执行', async () => {
    await swEval(`(__bmcp.testAutoConfirm='deny', true)`);
    const r = await call('navigate', { url: U('safety.html') });
    const c = await call('click', { ref: ref(r.text, 'button', '删除订单') });
    expect(c.isError && c.text.includes('ACTION_DENIED'), '应返回 ACTION_DENIED', c.text);
    const s = await call('snapshot');
    expect(s.text.includes('paragraph') && !s.text.includes('deleted'), '被拒绝的点击不应执行', s.text);
  });

  await test('插件：普通动作不弹确认', async () => {
    const s = await call('snapshot');
    const c = await call('click', { ref: ref(s.text, 'button', '查看详情') });
    expect(!c.isError && c.text.includes('viewed'), '普通按钮应直接执行', c.text);
    const q = await call('type', { ref: ref(s.text, 'textbox', '搜索'), text: 'hello', submit: true });
    expect(!q.isError && q.text.includes('searched'), 'GET 搜索表单回车不应需要确认', q.text);
  });

  await test('插件：POST 表单提交、输入密码需要确认', async () => {
    const s = await call('snapshot');
    const save = await call('click', { ref: ref(s.text, 'button', '保存资料') });
    expect(save.isError && save.text.includes('ACTION_DENIED'), 'POST 表单提交应需要确认', save.text);
    const pwd = await call('type', { ref: ref(s.text, 'textbox', '登录密码'), text: 'secret' });
    expect(pwd.isError && pwd.text.includes('ACTION_DENIED'), '输入密码应需要确认', pwd.text);
  });

  await test('插件：用户允许后动作执行，审计记录里密码被打码', async () => {
    await swEval(`(__bmcp.testAutoConfirm='allow', true)`);
    const s = await call('snapshot');
    const c = await call('click', { ref: ref(s.text, 'button', '删除订单') });
    expect(!c.isError && c.text.includes('deleted'), '允许后应执行', c.text);
    await call('type', { ref: ref(s.text, 'textbox', '登录密码'), text: 'secret' });
    const audit = await swEval(`chrome.storage.local.get('audit').then(a=>JSON.stringify(a.audit.slice(-3)))`);
    expect(!audit.includes('secret') && audit.includes('allow'), '审计记录应有确认结果且密码打码', audit);
  });

  await test('插件：真实确认弹窗 → 点"允许这一次"后动作执行', async () => {
    await swEval(`(__bmcp.testAutoConfirm=null, true)`);
    const r = await call('navigate', { url: U('safety.html') });
    const pending = call('click', { ref: ref(r.text, 'button', '删除订单') });
    let confirmTarget: any;
    for (let i = 0; i < 40 && !confirmTarget; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      confirmTarget = list.find((t) => t.url.includes('/confirm.html'));
    }
    expect(confirmTarget, '没有弹出确认窗口');
    await new Promise((res) => setTimeout(res, 500));
    const shown = await cdpOnce(confirmTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: `document.getElementById('target').textContent + ' | ' + document.getElementById('reason').textContent`,
      returnByValue: true,
    });
    expect(String(shown?.result?.value).includes('删除订单'), '确认窗口应显示目标按钮', JSON.stringify(shown));
    await cdpOnce(confirmTarget.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: `document.getElementById('allow').click()` });
    const c = await pending;
    expect(!c.isError && c.text.includes('deleted'), '点"允许"后应执行', c.text);
  });

  await test('插件：确认窗口被直接关掉 = 拒绝', async () => {
    const r = await call('navigate', { url: U('safety.html') });
    const pending = call('click', { ref: ref(r.text, 'button', '删除订单') });
    let confirmTarget: any;
    for (let i = 0; i < 40 && !confirmTarget; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      confirmTarget = list.find((t) => t.url.includes('/confirm.html'));
    }
    expect(confirmTarget, '没有弹出确认窗口');
    await swEval(`chrome.windows.getAll({populate:true}).then(ws=>{const w=ws.find(x=>x.tabs.some(t=>t.url.includes('confirm.html')));return chrome.windows.remove(w.id).then(()=>true)})`);
    const c = await pending;
    expect(c.isError && c.text.includes('ACTION_DENIED'), '关掉确认窗口应视为拒绝', c.text);
    await swEval(`(__bmcp.testAutoConfirm='allow', true)`);
  });

  await test('插件：敏感网站上任何操作都要确认', async () => {
    await swEval(`(__bmcp.testAutoConfirm='deny', true)`);
    await swEval(`chrome.storage.local.set({sensitive:['127.0.0.1']}).then(()=>true)`);
    await new Promise((r) => setTimeout(r, 10_500)); // MCP 侧策略缓存 10 秒
    const s = await call('snapshot');
    const c = await call('click', { ref: ref(s.text, 'button', '查看详情') });
    expect(c.isError && c.text.includes('ACTION_DENIED'), '敏感网站上的普通点击也应需要确认', c.text);
    await swEval(`chrome.storage.local.remove('sensitive').then(()=>true)`);
    await swEval(`(__bmcp.testAutoConfirm=null, true)`);
  });

  await test('插件：把标签页拖出 AI 分组后，AI 立即失去控制', async () => {
    await new Promise((r) => setTimeout(r, 10_500));
    await swEval(`(__bmcp.testAutoConfirm='allow', true)`);
    await call('navigate', { url: U('target.html') + '?drag' });
    await swEval(`chrome.tabs.query({}).then(ts=>{const t=ts.find(x=>x.url.includes('?drag'));return chrome.tabs.ungroup(t.id).then(()=>true)})`);
    await new Promise((r) => setTimeout(r, 500));
    const list = await call('tabs', { action: 'list' });
    expect(!list.text.includes('?drag'), '拖出分组的标签页不应再被 AI 控制', list.text);
    await swEval(`chrome.tabs.query({}).then(ts=>{const t=ts.find(x=>x.url.includes('?drag'));return t?chrome.tabs.remove(t.id).then(()=>true):true})`);
  });

  await test('插件：点"全部停止"后 AI 被拒绝（USER_PAUSED），恢复后可继续', async () => {
    const popup = await openUserTab(`chrome-extension://${EXT_ID}/popup.html`);
    await new Promise((r) => setTimeout(r, 800));
    await popup.eval(`document.getElementById('toggle').click(), true`);
    await new Promise((r) => setTimeout(r, 800));
    const badge = await swEval(`chrome.action.getBadgeText({})`);
    const r = await call('navigate', { url: U('target.html') });
    expect(r.isError && r.text.includes('USER_PAUSED'), '暂停后应返回 USER_PAUSED', r.text);
    expect(badge === '停', '图标徽标应显示"停"', String(badge));
    await popup.eval(`document.getElementById('toggle').click(), true`);
    await new Promise((r) => setTimeout(r, 800));
    const r2 = await call('navigate', { url: U('target.html') });
    expect(!r2.isError && r2.text.includes('Target Heading'), '恢复后应能继续操作', r2.text);
    await cdpOnce(
      ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any).webSocketDebuggerUrl,
      'Target.closeTarget',
      { targetId: popup.id },
    );
  });

  await test('插件：两个 MCP 实例交替使用，自动接管', async () => {
    const first = client;
    const second = await makeClientRef();
    try {
      client = second;
      const b = await call('navigate', { url: U('target.html') + '?second' });
      expect(!b.isError && b.text.includes('Target Heading'), '第二个实例应能接管并操作', b.text);
      client = first;
      const a = await call('navigate', { url: U('target.html') + '?first' });
      expect(!a.isError && a.text.includes('Target Heading'), '第一个实例应能接管回来', a.text);
      expect(a.text.includes('接管'), '应提示发生过接管', a.text);
      client = second;
      const b2 = await call('snapshot');
      expect(!b2.isError, '再次切换后第二个实例仍能操作', b2.text);
    } finally {
      client = first;
      await second.close();
    }
    const again = await call('snapshot');
    expect(!again.isError, '第二个实例退出后第一个实例应能继续', again.text);
  });

  await test('插件：非插件来源的连接被拒绝', async () => {
    const reason = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:9230/extension?v=1&token=${'x'.repeat(32)}`);
      ws.onclose = (ev) => resolve(`${ev.code} ${ev.reason}`);
      ws.onerror = () => undefined;
      setTimeout(() => resolve('timeout'), 5000);
    });
    expect(reason.startsWith('4001') && reason.includes('origin'), '应因 Origin 不匹配被拒绝', reason);
  });

  await swEval(`(__bmcp.testAutoConfirm='allow', true)`);
}

main().catch((e) => {
  process.stderr.write(`smoke 异常：${(e as Error).stack}\n`);
  process.exit(1);
});
