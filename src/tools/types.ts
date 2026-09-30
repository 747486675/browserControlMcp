import type { ZodRawShape, z } from 'zod';
import type { ToolResult } from '../core/executor.js';

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  /** 是否只读（MCP annotations） */
  readOnly?: boolean;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>;
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
