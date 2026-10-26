// 参考图压缩：用 sharp 转 JPEG、按 EXIF 摆正、限制最大边长。
// 目的：省上传带宽 + 省 duomi 从 COS 读取的下行带宽 + 省 COS 容量。
// 找不到 sharp 时降级为原样返回（不阻断流程）。
import { stat } from "node:fs/promises";

let _sharp;
async function loadSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    const mod = await import("sharp");
    _sharp = mod.default ?? mod;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

/**
 * 压缩一张本地参考图。
 * @param inputPath 原图本地路径
 * @param opts.maxEdge 最长边像素上限（超出等比缩小）
 * @param opts.quality JPEG 质量
 * @returns {Promise<{path: string, compressed: boolean, before?: number, after?: number}>}
 */
export async function compressImage(inputPath, { maxEdge = 2048, quality = 85 } = {}) {
  const sharp = await loadSharp();
  if (!sharp) return { path: inputPath, compressed: false };

  const before = (await stat(inputPath)).size;
  const out = inputPath.replace(/\.[^.]+$/, "") + ".ig-compressed.jpg";

  await sharp(inputPath)
    .rotate() // 按 EXIF 方向摆正
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true, // 不放大小图
    })
    .jpeg({ quality, mozjpeg: true })
    .toFile(out);

  const after = (await stat(out)).size;
  return { path: out, compressed: true, before, after };
}
