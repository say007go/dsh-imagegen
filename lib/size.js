// 三层尺寸解析 + 宽高比换算。
// 优先级：本次 size 参数 > 本次 aspect 参数 > 场景预设(size/aspect) > 配置 defaultSize。

/**
 * 按三层规则解析最终分辨率。
 * @param opts.size 本次调用显式指定的分辨率，如 "1024x1024"
 * @param opts.aspect 本次调用显式指定的宽高比，如 "16:9"
 * @param opts.scenario 场景预设对象（可选）
 * @param opts.aspectPresets 宽高比预设列表
 * @param opts.defaultSize 配置兜底分辨率
 * @returns {string} 形如 "WxH"
 */
export function resolveSize({ size, aspect, scenario, aspectPresets, defaultSize }) {
  // 1) 本次显式 size 最优先
  if (size) return normalizeSize(size);

  // 2) 本次显式 aspect
  if (aspect) {
    const fromAspect = sizeFromAspect(aspect, aspectPresets);
    if (fromAspect) return fromAspect;
  }

  // 3) 场景预设：先 size，后 aspect
  if (scenario) {
    if (scenario.size) return normalizeSize(scenario.size);
    if (scenario.aspect) {
      const fromAspect = sizeFromAspect(scenario.aspect, aspectPresets);
      if (fromAspect) return fromAspect;
    }
  }

  // 4) 配置兜底
  if (defaultSize) return normalizeSize(defaultSize);

  return "";
}

/** 把 "16:9" 或 "16x9" 之类的比值映射到预设分辨率；找不到返回 undefined。 */
function sizeFromAspect(ratio, presets) {
  const key = String(ratio).trim();
  const hit = (presets ?? []).find(
    (p) => p.ratio === key || p.ratio.replace(/[:xX]/g, ":") === key.replace(/[:xX]/g, ":"),
  );
  if (hit) return `${Math.round(hit.width)}x${Math.round(hit.height)}`;
  return undefined;
}

/** 规整用户输入的分辨率：支持 "1024x1024" / "1024X1024" / "1024*1024"。 */
function normalizeSize(raw) {
  const m = String(raw).trim().match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
  if (!m) return String(raw).trim();
  return `${m[1]}x${m[2]}`;
}
