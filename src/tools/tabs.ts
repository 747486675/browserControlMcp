import { z } from 'zod';
import { config } from '../config.js';
import { session } from '../browser/session.js';
import { ToolError } from '../core/errors.js';
import { run } from '../core/executor.js';
import { normalizeUrl } from './navigation.js';
import { defineTool } from './types.js';

export const tabs = defineTool({
  name: 'tabs',
  description: '管理标签页：list 列出全部；new 新建（可带 url）；select 切换到指定标签页；close 关闭（默认关闭当前）。之后的操作都作用于"当前标签页"。',
  schema: {
    action: z.enum(['list', 'new', 'select', 'close']),
    id: z.string().optional().describe('标签页 ID，如 t2（select/close 用）'),
    url: z.string().optional().describe('new 时打开的网址'),
  },
  handler: ({ action, id, url }) =>
    run(
      { name: `tabs ${action}`, tabScoped: false, settle: false, idempotent: action === 'list', allowWithDialog: action === 'list', snapshotAfter: action !== 'list' && action !== 'close' },
      async () => {
        switch (action) {
          case 'new': {
            const target = url ? normalizeUrl(url) : undefined;
            const t = await session.newTab(target);
            return { text: `已新建并切换到标签页 ${t.id}` };
          }
          case 'select': {
            const t = requireTab(id);
            session.tabs.setActive(t);
            await t.bringIntoView();
            return { text: `已切换到标签页 ${t.id}` };
          }
          case 'close': {
            const t = id ? requireTab(id) : session.tabs.active;
            if (!t) throw new ToolError('NO_TAB', '没有可关闭的标签页');
            // 有界面的 Chrome 关掉最后一个标签页会整个退出，先补一个空白页
            if (config.mode === 'cdp' && session.tabs.list().length <= 1) await session.newTab();
            await t.page.close({ runBeforeUnload: false });
            const now = session.tabs.active;
            if (now && config.mode === 'cdp') await now.page.bringToFront().catch(() => undefined);
            return { text: `已关闭标签页 ${t.id}${now ? `，当前标签页为 ${now.id}` : ''}` };
          }
          default:
            break;
        }
        await session.ensure();
        const active = session.tabs.active;
        const lines: string[] = [];
        for (const t of session.tabs.list()) {
          const d = await t.describe();
          lines.push(`${t === active ? '*' : ' '} ${d.id}  ${d.title || '(无标题)'}  ${d.url}`);
        }
        return { text: lines.length ? `标签页（* 为当前）：\n${lines.join('\n')}` : '没有打开的标签页' };
      },
    ),
});

function requireTab(id: string | undefined) {
  if (!id) throw new ToolError('INVALID_ARGUMENT', '需要提供标签页 id');
  const t = session.tabs.byId(id.trim());
  if (!t || t.closed) throw new ToolError('TAB_CLOSED', `标签页 ${id} 不存在`);
  return t;
}
