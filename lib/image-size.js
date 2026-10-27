// 从图片字节头读取宽高/媒体类型（PNG / JPEG / GIF / WebP），不依赖 sharp。
// 只读头部，不解码整张图；解析失败返回 undefined，由调用方标注“未校验”。

export function imageSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) return undefined;

  // PNG：8 字节签名 + IHDR，宽高为 big-endian
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // GIF：GIF87a / GIF89a，宽高为 little-endian
  const gif = bytes.toString("ascii", 0, 6);
  if ((gif === "GIF87a" || gif === "GIF89a") && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }

  // JPEG：扫 SOF0/SOF2 等帧头，宽高在段内偏移 +7/+5
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (i + 4 > bytes.length) return undefined;
      const len = bytes.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      const isFrame = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (i + 9 > bytes.length) return undefined;
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return undefined;
  }

  // WebP：RIFF....WEBP；VP8X 为 24-bit canvas，VP8 为 14-bit 帧尺寸，VP8L 为 14-bit 无损尺寸
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 ") {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
      };
    }
  }

  return undefined;
}

/** 媒体类型嗅探（只看文件头，供 COS/multipart 使用）。 */
export function imageMediaType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** 与媒体类型对应的扩展名；未知类型返回 undefined。 */
export function imageExtension(bytes) {
  const mediaType = imageMediaType(bytes);
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/gif") return ".gif";
  if (mediaType === "image/webp") return ".webp";
  return undefined;
}

export function imageSizeLabel(bytes) {
  const size = imageSize(bytes);
  return size ? `${size.width}x${size.height}` : undefined;
}
