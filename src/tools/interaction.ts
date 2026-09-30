import { z } from 'zod';
import { config } from '../config.js';
import { resolveRef } from '../browser/snapshot.js';
import { ToolError } from '../core/errors.js';
import { run } from '../core/executor.js';
import { guard } from '../safety/policy.js';
import { defineTool } from './types.js';

const refArg = z.string().describe('目标元素的 ref（来自 snapshot，如 e12）');
const elementArg = z.string().optional().describe('元素的简短描述（仅用于日志，便于人工排查）');

export const click = defineTool({
  name: 'click',
  description: '点击元素。会自动滚动到可见并等待元素可点击。返回点击后的页面快照和发生的事件（跳转、新标签页、弹窗、下载）。',
  schema: {
    ref: refArg,
    element: elementArg,
    button: z.enum(['left', 'right', 'middle']).optional(),
    doubleClick: z.boolean().optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().describe('按住的修饰键'),
  },
  handler: ({ ref, button, doubleClick, modifiers }) =>
    run({ name: `click ${ref}`, snapshotAfter: true }, async ({ tab }) => {
      const loc = await resolveRef(tab, ref);
      await guard({ action: 'click', tab, locator: loc });
      const opts = { button, modifiers, timeout: config.actionTimeout };
      if (doubleClick) await loc.dblclick(opts);
      else await loc.click(opts);
      return { text: `已${doubleClick ? '双击' : '点击'} ${ref}` };
    }),
});

export const type = defineTool({
  name: 'type',
  description: '在输入框中输入文字。默认先清空再整体填入（最稳）；slowly=true 时逐字输入，适用于依赖键盘事件的输入框（如搜索联想）。submit=true 时输入后按回车。',
  schema: {
    ref: refArg,
    element: elementArg,
    text: z.string().describe('要输入的文字'),
    submit: z.boolean().optional().describe('输入后按 Enter'),
    slowly: z.boolean().optional().describe('逐字输入'),
  },
  handler: ({ ref, text, submit, slowly }) =>
    run({ name: `type ${ref}`, snapshotAfter: true }, async ({ tab }) => {
      const loc = await resolveRef(tab, ref);
      await guard({ action: 'type', tab, locator: loc, value: text, submit });
      if (slowly) {
        await loc.fill('', { timeout: config.actionTimeout });
        await loc.pressSequentially(text, { delay: 40, timeout: config.actionTimeout + text.length * 100 });
      } else {
        await loc.fill(text, { timeout: config.actionTimeout });
      }
      if (submit) await loc.press('Enter', { timeout: config.actionTimeout });
      return { text: `已在 ${ref} 输入 ${JSON.stringify(text.length > 50 ? text.slice(0, 50) + '…' : text)}${submit ? ' 并回车' : ''}` };
    }),
});

export const pressKey = defineTool({
  name: 'press_key',
  description: '在当前页面按键，如 Enter、Escape、Tab、ArrowDown、PageDown，或组合键 Control+A。',
  schema: {
    key: z.string().describe('按键名，参见 Playwright keyboard.press 的写法'),
  },
  handler: ({ key }) =>
    run({ name: `press ${key}`, snapshotAfter: true }, async ({ tab }) => {
      await guard({ action: 'press_key', tab, key });
      await tab.page.keyboard.press(key);
      return { text: `已按下 ${key}` };
    }),
});

export const selectOption = defineTool({
  name: 'select_option',
  description: '在下拉框（<select>）中选择选项，可按选项的值或文字选择。',
  schema: {
    ref: refArg,
    element: elementArg,
    values: z.array(z.string()).min(1).describe('要选中的选项（value 或显示文字）'),
  },
  handler: ({ ref, values }) =>
    run({ name: `select ${ref}`, snapshotAfter: true }, async ({ tab }) => {
      const loc = await resolveRef(tab, ref);
      await guard({ action: 'select_option', tab, locator: loc, value: values.join(', ') });
      const chosen = await loc.selectOption(values, { timeout: config.actionTimeout });
      return { text: `已选择 ${chosen.join(', ')}` };
    }),
});

export const hover = defineTool({
  name: 'hover',
  description: '鼠标悬停到元素上（用于展开悬停菜单等）。',
  schema: { ref: refArg, element: elementArg },
  handler: ({ ref }) =>
    run({ name: `hover ${ref}`, snapshotAfter: true }, async ({ tab }) => {
      const loc = await resolveRef(tab, ref);
      await loc.hover({ timeout: config.actionTimeout });
      return { text: `已悬停 ${ref}` };
    }),
});

export const scroll = defineTool({
  name: 'scroll',
  description: '滚动页面。指定 ref 时把该元素滚动到可见；否则按方向滚动页面（amount 为像素，默认一屏的 80%）。',
  schema: {
    ref: z.string().optional(),
    direction: z.enum(['down', 'up', 'left', 'right']).optional(),
    amount: z.number().int().positive().optional(),
  },
  handler: ({ ref, direction, amount }) =>
    run({ name: 'scroll', snapshotAfter: true }, async ({ tab }) => {
      if (ref) {
        const loc = await resolveRef(tab, ref);
        await loc.scrollIntoViewIfNeeded({ timeout: config.actionTimeout });
        return { text: `已滚动到 ${ref}` };
      }
      const dir = direction ?? 'down';
      const vh = await tab.page.evaluate(() => [window.innerWidth, window.innerHeight] as const).catch(() => [1200, 800] as const);
      const px = amount ?? Math.round((dir === 'left' || dir === 'right' ? vh[0] : vh[1]) * 0.8);
      const dx = dir === 'left' ? -px : dir === 'right' ? px : 0;
      const dy = dir === 'up' ? -px : dir === 'down' ? px : 0;
      await tab.page.mouse.wheel(dx, dy);
      return { text: `已向${{ down: '下', up: '上', left: '左', right: '右' }[dir]}滚动 ${px}px` };
    }),
});

export const waitFor = defineTool({
  name: 'wait_for',
  description: '等待某个条件：文字出现（text）、文字消失（textGone），或单纯等待若干毫秒（ms）。',
  schema: {
    text: z.string().optional(),
    textGone: z.string().optional(),
    ms: z.number().int().positive().max(30_000).optional(),
    timeout: z.number().int().positive().max(55_000).optional().describe('最长等待毫秒数，默认 15000'),
  },
  readOnly: true,
  handler: ({ text, textGone, ms, timeout }) =>
    run({ name: 'wait_for', idempotent: true, snapshotAfter: true }, async ({ tab }) => {
      const t = timeout ?? 15_000;
      if (!text && !textGone && !ms) throw new ToolError('INVALID_ARGUMENT', '需要提供 text、textGone 或 ms 之一');
      if (ms) await tab.page.waitForTimeout(ms);
      if (text) await tab.page.getByText(text).first().waitFor({ state: 'visible', timeout: t });
      if (textGone) await tab.page.getByText(textGone).first().waitFor({ state: 'hidden', timeout: t });
      return { text: `等待完成${text ? `：已出现「${text}」` : ''}${textGone ? `：「${textGone}」已消失` : ''}${ms ? `（${ms}ms）` : ''}` };
    }),
});
