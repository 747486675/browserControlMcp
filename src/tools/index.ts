import { handleDialog, waitForDownload } from './dialogs-downloads.js';
import { click, hover, pressKey, scroll, selectOption, type, waitFor } from './interaction.js';
import { browserStatus, find, goBack, goForward, navigate, readTextTool, reload, screenshot, snapshot } from './navigation.js';
import { tabs } from './tabs.js';
import type { ToolDef } from './types.js';

export const allTools: ToolDef<any>[] = [
  browserStatus,
  navigate,
  goBack,
  goForward,
  reload,
  snapshot,
  find,
  readTextTool,
  screenshot,
  click,
  type,
  pressKey,
  selectOption,
  hover,
  scroll,
  waitFor,
  tabs,
  handleDialog,
  waitForDownload,
];
