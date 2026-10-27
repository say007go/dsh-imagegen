// 腾讯云 COS 封装：上传本地文件 + 生成签名 URL。
// 只有图生图的本地参考图会走这里（省 COS 用量的关键）。
import COS from "cos-nodejs-sdk-v5";

export function createCosClient({ secretId, secretKey }) {
  if (!secretId || !secretKey) {
    throw new Error("COS 凭证未配置：请在设置里填写 SecretId/SecretKey，或配置对应环境变量");
  }
  return new COS({ SecretId: secretId, SecretKey: secretKey, Timeout: 60000 });
}

/** 上传本地文件到 COS；ContentType 与真实字节格式一致，避免签名 URL 被错误解析。 */
export function uploadFile(cos, { bucket, region, key, filePath, contentType }) {
  return new Promise((resolve, reject) => {
    cos.sliceUploadFile(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        FilePath: filePath,
        ...(contentType ? { ContentType: contentType } : {}),
      },
      (err, data) => (err ? reject(wrapCosError("上传", err)) : resolve(data)),
    );
  });
}

/** 探测对象是否已存在（headObject）。任何异常都按"不存在"处理，由上传去暴露真实错误。 */
export function objectExists(cos, { bucket, region, key }) {
  return new Promise((resolve) => {
    cos.headObject({ Bucket: bucket, Region: region, Key: key }, (err) => resolve(!err));
  });
}

/** 生成签名 URL（生图站通过它读取参考图）。
 * 注意：SDK 的 getObjectUrl 回调是 (err, data)，data 为 { Url } 对象而非字符串。 */
export function getSignedUrl(cos, { bucket, region, key, expires = 7200 }) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl(
      { Bucket: bucket, Region: region, Key: key, Sign: true, Expires: expires },
      (err, data) => {
        if (err) return reject(wrapCosError("签名", err));
        const url = typeof data === "string" ? data : data?.Url ?? data?.url;
        if (!url || typeof url !== "string") {
          return reject(new Error("COS 签名失败：响应中未找到 Url 字段"));
        }
        resolve(url);
      },
    );
  });
}

function wrapCosError(op, err) {
  const msg = err?.message ?? err?.error?.Message ?? String(err);
  return new Error(`COS ${op}失败：${msg}`);
}
