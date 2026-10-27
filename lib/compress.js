// 参考图压缩：用 sharp 转 JPEG、按 EXIF 摆正、限制最大边长。
// 目的：省上传带宽 + 省生图站从 COS 读取的下行带宽 + 省 COS 容量。
// 找不到 sharp 时降级为原样返回，但保留真实媒体类型/扩展名，不伪装成 JPEG。
// 压缩产物一律写到系统临时目录，避免污染用户目录或附件仓库（调用方用后即删）。
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { imageExtension, imageMediaType } from "./image-size.js";

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

/** 只读文件头，用于无 sharp 时判断真实格式。 */
async function readHead(path, length = 16) {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 压缩一张本地参考图。
 * @param inputPath 原图本地路径
 * @param opts.maxEdge 最长边像素上限（超出等比缩小）
 * @param opts.quality JPEG 质量
 * @param opts.outDir 压缩产物目录（默认系统临时目录）
 * @returns {Promise<{path: string, compressed: boolean, mediaType: string, ext: string, before?: number, after?: number}>}
 */
export async function compressImage(inputPath, { maxEdge = 2048, quality = 85, outDir } = {}) {
  const sharp = await loadSharp();
  if (!sharp) {
    const head = await readHead(inputPath);
    const mediaType = imageMediaType(head);
    if (!mediaType) {
      throw new Error(`无法识别参考图格式：${inputPath}。请使用 PNG/JPEG/WebP/GIF，或确认 sharp 已安装。`);
    }
    return { path: inputPath, compressed: false, mediaType, ext: imageExtension(head) };
  }

  const before = (await stat(inputPath)).size;
  const stem = (basename(inputPath).replace(/\.[^.]+$/, "") || "ref").slice(0, 40);
  const out = join(outDir ?? tmpdir(), `ig-${randomBytes(4).toString("hex")}-${stem}.jpg`);

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
  return { path: out, compressed: true, mediaType: "image/jpeg", ext: ".jpg", before, after };
}
