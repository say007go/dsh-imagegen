// 尺寸解析：本次调用显式指定的 size 优先，否则用配置里的默认分辨率。
// 支持 "1024x1024" / "1024X1024" / "1024*1024" 等写法。

/**
 * 解析最终分辨率。
 * @param opts.size 本次调用显式指定的分辨率，如 "1024x1024"
 * @param opts.defaultSize 配置里的默认分辨率（兜底）
 * @returns {string} 形如 "WxH"
 */
export function resolveSize({ size, defaultSize }) {
  const explicit = normalizeSize(size);
  if (explicit) return explicit;
  return normalizeSize(defaultSize) || "";
}

/** 规整用户输入的分辨率字符串；无法识别时原样返回（交给生图站校验）。 */
function normalizeSize(raw) {
  if (raw === undefined || raw === null) return "";
  const m = String(raw).trim().match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
  if (!m) return String(raw).trim();
  return `${m[1]}x${m[2]}`;
}
