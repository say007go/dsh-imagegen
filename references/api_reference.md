# dsh-imagegen API 适配参考

本插件默认适配 duomi 任务式接口，同时支持标准 OpenAI 同步接口。换站时除了 `baseUrl`、`apiKey`、`model`，还要按站点确认 `protocol`、`img2imgMode` 和模型支持的 `defaultSize`。

## 1. 协议自动判定（protocol=auto）

```
POST {baseUrl}/images/generations?async=true
├─ 响应含 id / task_id          → 判定「异步任务」，轮询 taskPath（默认 /tasks/{id}）
├─ 响应含 data[].url / b64      → 判定「同步」，直接取图
└─ HTTP 报错（如拒绝 async 参数） → 重试纯同步 POST，取 data[].url
```

探测结果按 baseUrl 缓存，同一站只探测一次。可用 `protocol` 字段强制：

- `openai-sync`：标准 OpenAI 同步站；单次长请求，不轮询。
- `async-task`：任务式站点；配合 `taskPath`，默认 `/tasks/{id}`，可填完整 URL。
- `duomi-async`：`async-task` 的兼容别名。

`auto` 是 duomi 优先的默认值；标准 OpenAI 如果忽略 `?async=true` 且生成超过 30 秒，`auto` 可能被单请求超时打断，建议直接设 `openai-sync`。

## 2. 返回字段兼容

取图时依次尝试：`data[].url`、`data[].b64_json`、`data.images[].url`、`images[].url`、`url`、`output.url`。图片统一保存一份本地副本（`save_path` 或工作区 `images/`），base64/URL 都会读图片头补实际尺寸。

## 3. 图生图（img2imgMode）

| 模式 | 行为 | COS 用量 |
|------|------|---------|
| `image-array`（默认） | 在 `generations` 请求体里传 `image:[url]`。本地参考图→压缩→上传 COS→签名→传 URL | 仅本地参考图 |
| `edits-multipart` | 走 `{baseUrl}/images/edits`，以 multipart 直接传文件字节；按实际 MIME/扩展名，多图用 `image[]` | 无（直传字节） |

`image-array` 覆盖 duomi 及兼容此写法的站；严格走 OpenAI `/edits` 的站用 `edits-multipart`。

## 4. 生图站环境变量

| 变量 | 用途 |
|------|------|
| `IMAGEGEN_API_KEY` | `provider.apiKey` 为空时的兜底凭证/环境变量名 |

## 5. 腾讯云 COS 环境变量

| 变量 | 用途 |
|------|------|
| `TENCENT_COS_SECRET_ID` | `cos.secretId` 为空时兜底 |
| `TENCENT_COS_SECRET_KEY` | `cos.secretKey` 为空时兜底 |

## 6. 参考资料

- OpenAI Images API: https://platform.openai.com/docs/api-reference/images
- 腾讯云 COS Node.js SDK: https://cloud.tencent.com/document/product/436/8629
- cos-nodejs-sdk-v5: https://github.com/tencentyun/cos-nodejs-sdk-v5
