import type { Locator, Page } from 'playwright-core';
import { config } from '../config.js';
import { ToolError, normalizeError } from '../core/errors.js';
import type { Tab } from './tabs.js';

/**
 * 元素引用（ref）机制。
 * 使用 Playwright 1.63 公开 API：page.ariaSnapshot({ mode: 'ai' }) 生成带 [ref=eN] 的可访问性树，
 * 再用 `aria-ref=eN` 定位器找回元素。iframe 内元素的 ref 形如 f1e2。
 * ref 编号只增不减，元素消失后旧 ref 解析不到任何元素 → 判定为 REF_STALE，绝不会误点到别的元素。
 * 如需替换实现（比如自研注入脚本），只改这个文件。
 */

const REF_RE = /^(f\d+)?e\d+$/;

export interface SnapshotOptions {
  /** 只取这个元素及其子树 */
  ref?: string;
  /** 限制层级深度 */
  depth?: number;
  /** 最大字符数（默认 config.snapshotMaxChars） */
  maxChars?: number;
}

export async function takeSnapshot(tab: Tab, opts: SnapshotOptions = {}): Promise<string> {
  const page = tab.page;
  let yaml: string;
  try {
    yaml = opts.ref
      ? await (await resolveRef(tab, opts.ref)).ariaSnapshot({ mode: 'ai', depth: opts.depth, timeout: config.actionTimeout })
      : await snapshotWithRetry(page, opts.depth);
  } catch (e) {
    throw normalizeError(e);
  }
  const title = await page.title().catch(() => '');
  const header = `[标签页 ${tab.id}] ${title}\nURL: ${page.url()}${opts.ref ? `\n（局部快照：${opts.ref}）` : ''}\n`;
  let body = yaml.trim() || '(页面为空)';
  const max = opts.maxChars ?? config.snapshotMaxChars;
  if (body.length > max) {
    body =
      body.slice(0, max) +
      `\n... (快照过长已截断，共 ${body.length} 字符。建议：用 find 按关键词找元素，用 read_text 读取文字内容，或用 snapshot 的 ref/depth 参数只取某一部分)`;
  }
  return `${header}\n${body}`;
}

/** 在整页快照里按关键词查找元素，只返回匹配的行（带 ref），大页面上比完整快照省得多 */
export async function findInSnapshot(tab: Tab, query: string, limit: number): Promise<string> {
  let yaml: string;
  try {
    yaml = await snapshotWithRetry(tab.page);
  } catch (e) {
    throw normalizeError(e);
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lines = yaml.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    let text = line.trim().replace(/^- /, '');
    // 匹配到的是纯文本行（没有 ref）时，带上最近的有 ref 的上级元素，方便后续操作
    if (!/\[ref=/.test(text)) {
      const indent = line.search(/\S/);
      for (let j = i - 1; j >= 0; j--) {
        const pl = lines[j];
        if (pl.search(/\S/) < indent && /\[ref=/.test(pl)) {
          text += `   ← 所在元素：${pl.trim().replace(/^- /, '').slice(0, 160)}`;
          break;
        }
      }
    }
    hits.push(text.length > 300 ? text.slice(0, 300) + '…' : text);
  }
  const total = lines.filter((l) => words.every((w) => l.toLowerCase().includes(w))).length;
  if (!hits.length) return `没有找到包含「${query}」的元素。可换个关键词，或用 read_text 查看页面文字。`;
  return `找到 ${total} 处包含「${query}」的元素${total > hits.length ? `（只列出前 ${hits.length} 处，可调大 limit）` : ''}：\n${hits.map((h) => `- ${h}`).join('\n')}`;
}

/** 读取页面（或某个元素）的纯文本，适合读表格、文章等大块内容 */
export async function readText(tab: Tab, opts: { ref?: string; offset?: number; maxChars?: number }): Promise<string> {
  const loc = opts.ref ? await resolveRef(tab, opts.ref) : tab.page.locator('body');
  let text: string;
  try {
    text = await loc.innerText({ timeout: config.actionTimeout });
  } catch (e) {
    throw normalizeError(e);
  }
  text = text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const offset = Math.max(0, opts.offset ?? 0);
  const max = opts.maxChars ?? 20_000;
  const chunk = text.slice(offset, offset + max);
  const end = offset + chunk.length;
  const more = end < text.length ? `\n... （共 ${text.length} 字符，已显示 ${offset}–${end}。继续读取请用 offset=${end}）` : '';
  return `[标签页 ${tab.id}] ${tab.page.url()}${opts.ref ? `（区域 ${opts.ref}）` : ''}\n\n${chunk || '(没有文字内容)'}${more}`;
}

async function snapshotWithRetry(page: Page, depth?: number): Promise<string> {
  // 页面正在跳转时执行上下文会被销毁，稍等后重试
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.ariaSnapshot({ mode: 'ai', depth, timeout: config.actionTimeout });
    } catch (e) {
      const te = normalizeError(e);
      if (attempt < 2 && te.code === 'NAVIGATION_INTERRUPTED') {
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
        continue;
      }
      throw e;
    }
  }
}

/** 解析 ref -> Locator。不存在则立刻抛 REF_STALE（不等超时）。 */
export async function resolveRef(tab: Tab, ref: string): Promise<Locator> {
  const r = (ref || '').trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
  if (!REF_RE.test(r)) {
    throw new ToolError('INVALID_ARGUMENT', `无效的 ref "${ref}"`, {
      hint: 'ref 形如 e12 或 f1e3，来自 snapshot 结果里的 [ref=...]。',
      beforeDispatch: true,
    });
  }
  const loc = tab.page.locator(`aria-ref=${r}`);
  let count: number;
  try {
    count = await loc.count();
  } catch (e) {
    const te = normalizeError(e);
    te.beforeDispatch = true;
    throw te;
  }
  if (count === 0) {
    throw new ToolError('REF_STALE', `ref ${r} 对应的元素已不存在`, { beforeDispatch: true });
  }
  return loc.first();
}
