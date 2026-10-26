// dsh-imagegen 配置 schema。
// 所有 .volatile() 字段会自动出现在 DSH Web 的 Settings → Plugins 表单里，
// role("secret") 字段渲染为密码框并脱敏，用户直接填 api/key/SecretId/SecretKey。
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  // ---------- 生图中转站（duomi 或任意 OpenAI 兼容站）----------
  provider: z.object({
    baseUrl: z
      .string()
      .volatile()
      .default("https://duomiapi.com/v1")
      .description("生图站 Base URL，需兼容 /v1/images/generations。默认 duomi；换其它中转站改这里即可。没有 duomi 账号？点此注册：https://duomiapi.com/user/register?cps=S9hKE2Oq"),
    apiKey: z
      .string()
      .role("secret")
      .volatile()
      .description("生图站 API Key（直接填；留空则回退到环境变量 IMAGEGEN_API_KEY）。还没有账号？免注册开通 duomi：https://duomiapi.com/user/register?cps=S9hKE2Oq"),
    // ↓ 以下为普通配置字段（不进表单；如需修改直接编辑 cordis.patch.yml）
    apiKeyEnv: z
      .string()
      .role("credential-ref")
      .default("IMAGEGEN_API_KEY")
      .description("apiKey 为空时，从凭证库或环境变量按此名取 Key"),
    model: z
      .string()
      .volatile()
      .default("gpt-image-2.5-sunburst")
      .description("生图模型 id。duomi 已知：gpt-image-2 / gpt-image-2.5-flare / gpt-image-2.5-sunburst（支持 1k/2k/4k，分辨率不分档收费）。"),
    defaultSize: z
      .string()
      .volatile()
      .default("3840x2160")
      .description("兜底分辨率，需与所选模型支持的尺寸匹配。duomi 支持到 4k（如 3840x2160）且分辨率不分档收费。"),
    protocol: z
      .union([z.const("auto"), z.const("openai-sync"), z.const("duomi-async")])
      .default("auto")
      .description("auto 自动判定同步/异步协议；个别怪站可在配置文件里强制指定"),
    img2imgMode: z
      .union([z.const("image-array"), z.const("edits-multipart")])
      .default("image-array")
      .description("图生图传参：image-array 用 generations 传 image:[url]；edits-multipart 走 /edits 传文件"),
    n: z.number().step(1).min(1).max(8).default(1),
    pollIntervalMs: z.number().step(100).min(500).max(15000).default(3000),
    pollTimeoutMs: z.number().step(10000).min(20000).max(600000).default(300000),
  }),

  // ---------- 腾讯云 COS（仅图生图本地参考图时用到）----------
  cos: z.object({
    enabled: z.boolean().volatile().default(true),
    region: z.string().volatile().default("").description("COS 地域，如 ap-guangzhou"),
    bucket: z.string().volatile().default("").description("存储桶名，格式 name-appid"),
    secretId: z
      .string()
      .role("secret")
      .volatile()
      .description("腾讯云 SecretId（直接填；留空则回退到环境变量 TENCENT_COS_SECRET_ID）"),
    secretKey: z
      .string()
      .role("secret")
      .volatile()
      .description("腾讯云 SecretKey（直接填；留空则回退到环境变量 TENCENT_COS_SECRET_KEY）"),
    // ↓ 普通配置字段（不进表单）
    secretIdEnv: z
      .string()
      .role("credential-ref")
      .default("TENCENT_COS_SECRET_ID"),
    secretKeyEnv: z
      .string()
      .role("credential-ref")
      .default("TENCENT_COS_SECRET_KEY"),
    tempPrefix: z.string().default("duomi-input/").description("本地参考图上传 COS 的 key 前缀"),
    signExpires: z.number().step(60).min(60).max(604800).default(7200),
  }),

  // ---------- prompt 后缀：启用后每次提交都追加 ----------
  promptEnhance: z.object({
    enabled: z
      .boolean()
      .volatile()
      .default(true)
      .description("启用后，每次给生图站提交 prompt 都会在末尾追加下方后缀文本"),
    suffix: z
      .string()
      .volatile()
      .default("所有中文内容必须印刷级清晰，笔画完整无残缺。禁止出现乱码、模糊、变形、粘连、错别字。")
      .description("追加到每个 prompt 末尾的文本（印刷级中文守卫）"),
  }),
});
