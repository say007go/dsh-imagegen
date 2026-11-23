// 腾讯云 COS 封装：上传本地文件 + 生成签名 URL。
// 只有图生图的本地参考图会走这里（省 COS 用量的关键）。
//
// cos-nodejs-sdk-v5 会静态拉起 request → tough-cookie → psl 这条旧依赖链。
// 精简安装环境（例如端侧 profile）可能只落盘了部分传递依赖；如果在这里静态
// import，缺一个 psl 就会让整个插件 activate 失败，连文生图都用不了。
// 因此改为按需加载：插件激活不碰 SDK，只有真正上传本地参考图时才加载。
let CosCtor;

async function loadCosSdk() {
  if (CosCtor) return CosCtor;
  let mod;
  try {
    mod = await import("cos-nodejs-sdk-v5");
  } catch (error) {
    const detail = String(error?.message ?? error).split("\n")[0];
    const hint = /Cannot find (?:module|package)/i.test(detail) ? "这通常是插件依赖未完整安装。" : "";
    throw new Error(
      `COS SDK 加载失败（${detail}）。${hint}文生图与 URL 参考图不需要 COS，可正常使用；` +
      "本地参考图请改用图片 URL，或重装插件补齐依赖后重启 DSH。",
    );
  }
  const ctor = mod?.default ?? mod;
  if (typeof ctor !== "function") {
    throw new Error("COS SDK 加载失败：cos-nodejs-sdk-v5 未导出构造函数。");
  }
  CosCtor = ctor;
  return CosCtor;
}

export async function createCosClient({ secretId, secretKey }) {
  if (!secretId || !secretKey) {
    throw new Error("COS 凭证未配置：请在设置里填写 SecretId/SecretKey，或配置对应环境变量");
  }
  const COS = await loadCosSdk();
  try {
    return new COS({ SecretId: secretId, SecretKey: secretKey, Timeout: 60000 });
  } catch (error) {
    const detail = String(error?.message ?? error).split("\n")[0];
    throw new Error(
      `COS 客户端初始化失败（${detail}）。请检查 SecretId/SecretKey 是否正确，以及 region/bucket 配置。`,
    );
  }
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
