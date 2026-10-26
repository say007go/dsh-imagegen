// prompt 后缀追加：启用时，把配置的守卫文本追加到每一次提交的 prompt 末尾。
// 单次调用可传 skip（image_generate 的 enhance:false）临时跳过。

/**
 * 构建最终 prompt。
 * @param opts.prompt 原始 prompt
 * @param opts.enabled 配置：是否启用追加
 * @param opts.suffix 配置：要追加的文本
 * @param opts.skip 本次调用是否跳过追加
 * @returns {{ prompt: string, appended: boolean }}
 */
export function buildPrompt({ prompt, enabled, suffix, skip }) {
  const base = String(prompt ?? "").trim();
  const s = String(suffix ?? "").trim();
  if (skip || enabled !== true || !s) return { prompt: base, appended: false };
  return { prompt: [base, s].filter(Boolean).join("\n"), appended: true };
}
