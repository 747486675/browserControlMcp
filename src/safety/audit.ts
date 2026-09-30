import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export interface AuditEntry {
  action: string;
  url?: string;
  host?: string;
  target?: string;
  value?: string;
  risk?: string;
  decision: string;
  [k: string]: unknown;
}

/** 审计日志：每个动作一行 JSON，写入 logs/audit-YYYY-MM-DD.jsonl */
export function audit(entry: AuditEntry) {
  try {
    mkdirSync(config.logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(config.logDir, `audit-${day}.jsonl`), JSON.stringify({ time: new Date().toISOString(), mode: config.mode, ...entry }) + '\n');
  } catch {
    /* 审计失败不影响主流程 */
  }
}
