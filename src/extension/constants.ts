/** 插件 ID 由 extension/manifest.json 里固定的 key 决定，两边必须一致 */
export const EXTENSION_ID = 'chflgcopcgkalmdjfooaebbodljockfd';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** 插件与 MCP 之间的协议版本，不兼容时拒绝连接 */
export const PROTOCOL_VERSION = 1;
