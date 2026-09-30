import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// 重要：stdout 专供 MCP stdio 协议使用，任何日志都不能写到 stdout。
let logFile: string | undefined;
try {
  mkdirSync(config.logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  logFile = join(config.logDir, `browser-mcp-${day}.log`);
} catch {
  logFile = undefined;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, extra?: unknown) {
  let line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (extra !== undefined) {
    const detail = extra instanceof Error ? extra.stack || extra.message : safeJson(extra);
    line += ` ${detail}`;
  }
  line += '\n';
  if (logFile) {
    try {
      appendFileSync(logFile, line);
    } catch {
      /* ignore */
    }
  }
  if (level !== 'debug' || process.env.BROWSER_MCP_DEBUG === '1') process.stderr.write(line);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};

// 防止任何第三方代码误用 console.log 污染 stdout
console.log = (...args: unknown[]) => write('info', args.map(String).join(' '));
console.info = console.log;
console.debug = (...args: unknown[]) => write('debug', args.map(String).join(' '));
