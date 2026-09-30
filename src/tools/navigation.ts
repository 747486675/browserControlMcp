import { z } from 'zod';
import { config } from '../config.js';
import { session } from '../browser/session.js';
import { findInSnapshot, readText, takeSnapshot } from '../browser/snapshot.js';
import { ToolError } from '../core/errors.js';
import { run } from '../core/executor.js';
import { audit } from '../safety/audit.js';
import { defineTool } from './types.js';

export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) throw new ToolError('INVALID_ARGUMENT', '网址为空');
  if (/^javascript:/i.test(s)) throw new ToolError('INVALID_ARGUMENT', '不允许打开 javascript: 网址');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // 已有协议（http:, https:, about:, file: ...）
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  return `https://${s}`;
}

export const navigate = defineTool({
  name: 'navigate',
  description:
    '在当前标签页打开网址。默认返回打开后的页面快照（带 ref，用于后续 click/type）。内容很多的页面可设 snapshot=false，再用 find / read_text 按需读取。',
  schema: {
    url: z.string().describe('要打开的网址，可省略 https://'),
    snapshot: z.boolean().optional().describe('是否附带页面快照，默认 true'),
  },
  handler: ({ url, snapshot: withSnapshot }) =>
    run({ name: 'navigate', idempotent: true, snapshotAfter: withSnapshot !== false }, async ({ tab }) => {
      const target = normalizeUrl(url);
      audit({ action: 'navigate', url: target, decision: 'allowed' });
      const resp = await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
      if (config.mode === 'cdp') await tab.page.bringToFront().catch(() => undefined);
      const status = resp ? ` (HTTP ${resp.status()})` : '';
      return { text: `已打开 ${tab.page.url()}${status}` };
    }),
});

export const goBack = defineTool({
  name: 'go_back',
  description: '当前标签页后退一页。',
  schema: {},
  handler: () =>
    run({ name: 'go_back', snapshotAfter: true }, async ({ tab }) => {
      const before = tab.page.url();
      // 用 commit：从往返缓存(bfcache)恢复的页面不会再触发 DOMContentLoaded
      await tab.page.goBack({ waitUntil: 'commit' });
      await tab.waitDomReady(5_000);
      const after = tab.page.url();
      return { text: after !== before ? `已后退到 ${after}` : `没有可后退的页面（仍在 ${after}）` };
    }),
});

export const goForward = defineTool({
  name: 'go_forward',
  description: '当前标签页前进一页。',
  schema: {},
  handler: () =>
    run({ name: 'go_forward', snapshotAfter: true }, async ({ tab }) => {
      await tab.page.goForward({ waitUntil: 'commit' });
      await tab.waitDomReady(5_000);
      return { text: `当前页面 ${tab.page.url()}` };
    }),
});

export const reload = defineTool({
  name: 'reload',
  description: '刷新当前标签页。',
  schema: {},
  handler: () =>
    run({ name: 'reload', idempotent: true, snapshotAfter: true }, async ({ tab }) => {
      await tab.page.reload({ waitUntil: 'domcontentloaded' });
      return { text: `已刷新 ${tab.page.url()}` };
    }),
});

export const snapshot = defineTool({
  name: 'snapshot',
  description:
    '获取当前标签页的页面结构快照（可访问性树）。每个可交互元素带 [ref=eN]，click/type 等工具通过 ref 指定元素。页面变化后旧 ref 可能失效，需要重新 snapshot。页面很大时可用 ref 只取某个区域、用 depth 限制层级。',
  schema: {
    ref: z.string().optional().describe('只取这个元素及其内部（来自之前快照的 ref）'),
    depth: z.number().int().positive().max(50).optional().describe('限制层级深度，用于先看页面大致结构'),
  },
  readOnly: true,
  handler: ({ ref, depth }) =>
    run({ name: 'snapshot', idempotent: true, settle: false }, async ({ tab }) => {
      return { text: await takeSnapshot(tab, { ref, depth }) };
    }),
});

export const find = defineTool({
  name: 'find',
  description:
    '在当前页面按关键词查找元素（按钮、链接、输入框、文字等），只返回匹配的条目及其 ref。页面很大、完整快照被截断时，用它精确定位要操作的元素。多个关键词用空格分隔，需同时包含。',
  schema: {
    text: z.string().min(1).describe('关键词，如 "登录"、"G1234 预订"'),
    limit: z.number().int().positive().max(200).optional().describe('最多返回多少条，默认 30'),
  },
  readOnly: true,
  handler: ({ text, limit }) =>
    run({ name: 'find', idempotent: true, settle: false }, async ({ tab }) => {
      return { text: await findInSnapshot(tab, text, limit ?? 30) };
    }),
});

export const readTextTool = defineTool({
  name: 'read_text',
  description:
    '读取当前页面（或某个元素）的纯文本内容，适合读取表格、列表、文章等大量信息，比快照紧凑得多。内容过长时分段返回，用 offset 继续读取。',
  schema: {
    ref: z.string().optional().describe('只读这个元素内的文字（来自快照或 find 的 ref）'),
    offset: z.number().int().min(0).optional().describe('从第几个字符开始读，默认 0'),
    maxChars: z.number().int().positive().max(100_000).optional().describe('本次最多返回多少字符，默认 20000'),
  },
  readOnly: true,
  handler: ({ ref, offset, maxChars }) =>
    run({ name: 'read_text', idempotent: true, settle: false }, async ({ tab }) => {
      return { text: await readText(tab, { ref, offset, maxChars }) };
    }),
});

export const screenshot = defineTool({
  name: 'screenshot',
  description: '截图当前标签页（可指定 ref 只截某个元素）。用于快照看不清的场景（canvas、图片、复杂布局）。操作元素仍请用 snapshot 的 ref。',
  schema: {
    ref: z.string().optional().describe('只截这个元素'),
    fullPage: z.boolean().optional().describe('截整页（长页面），默认只截可视区域'),
  },
  readOnly: true,
  handler: ({ ref, fullPage }) =>
    run({ name: 'screenshot', idempotent: true, settle: false }, async ({ tab }) => {
      let buf: Buffer;
      if (ref) {
        const { resolveRef } = await import('../browser/snapshot.js');
        const loc = await resolveRef(tab, ref);
        buf = await loc.screenshot({ type: 'jpeg', quality: 70 });
      } else {
        buf = await tab.page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!fullPage, timeout: 4_000 }).catch(async (e) => {
          // 截图依赖渲染帧：窗口被遮挡/屏幕锁定时可能拿不到。把窗口提到前台后再试一次
          await tab.bringIntoView();
          return tab.page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!fullPage, timeout: 5_000 }).catch(() => {
            throw new ToolError('TIMEOUT', `截图失败：${(e as Error).message.split('\n')[0]}`, {
              hint: '浏览器窗口可能被最小化、被遮挡或屏幕已锁定，页面暂停了渲染。请让窗口保持可见后重试。snapshot 不受影响，可继续使用。',
            });
          });
        });
      }
      return { text: `截图：${tab.page.url()}`, images: [{ data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
    }),
});

export const browserStatus = defineTool({
  name: 'browser_status',
  description: '查看浏览器连接状态、标签页列表、待处理对话框和下载情况。会在需要时自动启动/重连浏览器。',
  schema: {},
  readOnly: true,
  handler: () =>
    run({ name: 'browser_status', tabScoped: false, settle: false, allowWithDialog: true, idempotent: true }, async () => {
      const lines =
        config.mode === 'extension'
          ? [
              `模式：插件模式（操作你日常的 Chrome，仅限"AI"标签页分组）`,
              `连接：${session.connected ? '已连接' : '未连接'}  ${session.version}`,
              `插件端口：${config.extPort}`,
              `危险动作确认：${config.safety ? '开启' : '关闭'}`,
              `下载位置：按你 Chrome 的下载设置`,
            ]
          : [
              `模式：CDP 模式（独立 profile）`,
              `连接：${session.connected ? '已连接' : '未连接'}  Chrome ${session.version}`,
              `调试端口：${config.cdpPort}`,
              `Profile：${config.userDataDir}`,
              `下载目录：${config.downloadDir}`,
            ];
      const active = session.tabs.active;
      lines.push('标签页：');
      for (const t of session.tabs.list()) {
        const d = await t.describe();
        lines.push(`  ${t === active ? '*' : ' '} ${d.id}  ${d.title || '(无标题)'}  ${d.url}`);
      }
      if (session.pendingDialog) lines.push(`待处理对话框：${session.pendingDialog.type}「${session.pendingDialog.message}」`);
      const inProgress = session.downloads.filter((r) => r.state === 'in_progress');
      if (inProgress.length) lines.push(`下载中：${inProgress.map((r) => r.suggestedFilename).join(', ')}`);
      return { text: lines.join('\n') };
    }),
});
