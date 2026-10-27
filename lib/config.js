// dsh-imagegen 配置 schema。
// 所有 .volatile() 字段会自动出现在 DSH Web 的 Settings → Plugins 表单里，
// role("secret") 字段渲染为密码框并脱敏，用户直接填 api/key/SecretId/SecretKey。
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  // ---------- 生图中转站（duomi 或其它 OpenAI 风格站）----------
  provider: z.object({
    baseUrl: z
      .string()
      .volatile()
      .default("https://duomiapi.com/v1")
      .description("生图站 Base URL，需兼容 /images/generations；默认 duomi，其它站填自己的地址。没有 duomi 账号？点此注册：https://duomiapi.com/user/register?cps=S9hKE2Oq"),
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
      .default("gpt-image-2.5-flare")
      .description("生图模型 id。默认 gpt-image-2.5-flare（duomi，速度较快）；其它站按实际模型填。duomi 已知还有 gpt-image-2 / gpt-image-2.5-sunburst（支持 1k/2k/4k，分辨率不分档收费）。"),
    defaultSize: z
      .string()
      .volatile()
      .default("3840x2160")
      .description("兜底分辨率，需与所选模型支持的尺寸匹配。默认 4K（duomi）；标准 OpenAI 等站点请改成模型支持的尺寸。"),
    protocol: z
      .union([z.const("auto"), z.const("openai-sync"), z.const("async-task"), z.const("duomi-async")])
      .volatile()
      .default("auto")
      .description("auto：duomi 优先自动判定；标准 OpenAI 同步站用 openai-sync；任务式站点用 async-task（duomi-async 是兼容别名）"),
    taskPath: z
      .string()
      .default("/tasks/{id}")
      .description("异步任务查询路径模板，支持 {id}，也可填完整 URL；默认 /tasks/{id}"),
    img2imgMode: z
      .union([z.const("image-array"), z.const("edits-multipart")])
      .volatile()
      .default("image-array")
      .description("图生图传参：image-array 用 generations 传 image:[url]（duomi/兼容站）；edits-multipart 走 /edits 传文件（标准 OpenAI）"),
    // 提交后先静默等待的时间：服务端出图普遍 ≥55 秒，立即轮询纯属空转
    initialPollDelayMs: z.number().step(1000).min(0).max(180000).default(30000),
    // 首查之后的轮询间隔（会轻微退避到 25 秒封顶）
    pollIntervalMs: z.number().step(100).min(500).max(30000).default(12000),
    pollTimeoutMs: z.number().step(10000).min(20000).max(1800000).default(900000),
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
    tempPrefix: z.string().default("imagegen-input/").description("本地参考图上传 COS 的 key 前缀"),
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
      .description("追加到每个 prompt 末尾的文本"),
  }),
});
