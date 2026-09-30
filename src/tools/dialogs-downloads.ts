import { z } from 'zod';
import { session, formatDownload } from '../browser/session.js';
import { run } from '../core/executor.js';
import { defineTool } from './types.js';

export const handleDialog = defineTool({
  name: 'handle_dialog',
  description: '处理页面弹出的 alert/confirm/prompt 对话框。accept=true 确认，false 取消；prompt 可附带输入文字。',
  schema: {
    accept: z.boolean(),
    promptText: z.string().optional(),
  },
  handler: ({ accept, promptText }) =>
    run({ name: 'handle_dialog', tabScoped: false, allowWithDialog: true, settle: false, snapshotAfter: true }, async () => {
      const text = await session.handleDialog(accept, promptText);
      // 给页面一点时间响应对话框结果
      await new Promise((r) => setTimeout(r, 300));
      return { text };
    }),
});

export const waitForDownload = defineTool({
  name: 'wait_for_download',
  description: '等待下载完成并返回保存路径。点击下载链接后调用。已完成但尚未报告的下载会直接返回。',
  schema: {
    timeout: z.number().int().positive().max(55_000).optional().describe('最长等待毫秒数，默认 30000'),
  },
  readOnly: true,
  handler: ({ timeout }) =>
    run({ name: 'wait_for_download', tabScoped: false, settle: false, allowWithDialog: true, idempotent: true }, async () => {
      const done = await session.waitForDownloads(timeout ?? 30_000);
      const inProgress = session.downloads.filter((r) => r.state === 'in_progress');
      const lines = done.map(formatDownload);
      if (inProgress.length) lines.push(`仍在下载中：${inProgress.map((r) => r.suggestedFilename).join(', ')}`);
      return { text: lines.length ? lines.join('\n') : '在等待时间内没有检测到下载。' };
    }),
});
