// dsh-imagegen 主插件：注册 image_generate 工具，并内嵌 imagegen 技能。
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, basename, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { Config } from "./config.js";
import { resolveSize } from "./size.js";
import { buildPrompt } from "./prompt.js";
import { compressImage } from "./compress.js";
import { generate } from "./protocol.js";
import { createCosClient, uploadFile, getSignedUrl, objectExists } from "./cos.js";

export const name = "imagegen";
export const inject = ["tools", "credentials"];
// Cordis loader 通过入口导出的 Config schema 校验配置并生成设置表单，必须导出。
export { Config };

const isUrl = (s) => /^https?:\/\//i.test(String(s));
const stripTrailing = (s) => String(s ?? "").replace(/\/+$/, "");

/** 读取一条凭证：直接填的值 > 凭证库 > 环境变量。 */
async function resolveSecret(ctx, direct, envRef) {
  if (direct && String(direct).trim()) return String(direct).trim();
  if (envRef) {
    try {
      const hit = await ctx.credentials?.resolve(credentialRef(envRef));
      if (hit?.value) return hit.value;
    } catch { /* ignore */ }
    if (process.env[envRef]) return process.env[envRef];
  }
  return "";
}

/** 双态读取：volatile 字段是引用（需 .get()），普通字段是字面值。 */
const val = (x) => (x !== null && typeof x === "object" && typeof x.get === "function") ? x.get() : x;

/** 把 live 配置读成普通对象（volatile 引用与普通字段统一处理）。 */
function readConfig(config) {
  return {
    provider: {
      baseUrl: val(config.provider.baseUrl),
      apiKey: val(config.provider.apiKey),
      apiKeyEnv: val(config.provider.apiKeyEnv),
      model: val(config.provider.model),
      defaultSize: val(config.provider.defaultSize),
      protocol: val(config.provider.protocol),
      img2imgMode: val(config.provider.img2imgMode),
      n: val(config.provider.n),
      pollIntervalMs: val(config.provider.pollIntervalMs),
      pollTimeoutMs: val(config.provider.pollTimeoutMs),
    },
    cos: {
      enabled: val(config.cos.enabled),
      region: val(config.cos.region),
      bucket: val(config.cos.bucket),
      secretId: val(config.cos.secretId),
      secretKey: val(config.cos.secretKey),
      secretIdEnv: val(config.cos.secretIdEnv),
      secretKeyEnv: val(config.cos.secretKeyEnv),
      tempPrefix: val(config.cos.tempPrefix),
      signExpires: val(config.cos.signExpires),
    },
    promptEnhance: {
      enabled: val(config.promptEnhance.enabled),
      suffix: val(config.promptEnhance.suffix),
    },
  };
}

function resolveLocal(ref) {
  return isAbsolute(ref) ? ref : join(process.cwd(), ref);
}

/** 解析 SKILL.md 的 frontmatter description 与正文。 */
function parseSkill(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let description = "";
  let content = raw;
  if (m) {
    const dm = /^description:\s*(.*)$/m.exec(m[1]);
    if (dm) description = dm[1].trim();
    content = raw.slice(m[0].length).trim();
  }
  return { description, content };
}

export function apply(ctx, config) {
  // 按 baseUrl 缓存探测到的协议，避免每次调用重复探测
  const protocolCache = new Map();

  // 内嵌 imagegen 技能（skills 服务存在时）
  try {
    const skillPath = fileURLToPath(new URL("../skills/imagegen/SKILL.md", import.meta.url));
    const { description, content } = parseSkill(readFileSync(skillPath, "utf8"));
    ctx.skills?.register({
      name: "imagegen",
      description,
      content,
      invocation: { modelInvocable: true, userInvocable: true },
    });
  } catch (e) {
    ctx.logger?.warn?.(`imagegen: 内嵌技能注册失败（不影响工具）：${e.message}`);
  }

  // 上传一张本地参考图到 COS 并签名（仅 image-array 模式的本地文件走这里）。
  // key 采用内容寻址（压缩内容的 sha256 前 16 位）：同一张参考图重跑时 key 不变，
  // 且先 HEAD 探测——已存在则直接复用签名 URL，不重复上传字节（带宽优先）。
  async function uploadLocalRef(c, compPath, origRef) {
    if (!c.cos.enabled) {
      throw new Error("图生图参考图是本地文件，但 COS 未启用。请在设置里启用 COS，或直接提供参考图 URL。");
    }
    if (!c.cos.region || !c.cos.bucket) {
      throw new Error("COS region / bucket 未配置：图生图本地参考图需要先上传 COS 才能被生图站读取。");
    }
    const secretId = await resolveSecret(ctx, c.cos.secretId, c.cos.secretIdEnv);
    const secretKey = await resolveSecret(ctx, c.cos.secretKey, c.cos.secretKeyEnv);
    const cos = createCosClient({ secretId, secretKey });
    const hash = createHash("sha256").update(await readFile(compPath)).digest("hex").slice(0, 16);
    const stem = basename(origRef).replace(/\.[^.]+$/, "");
    const key = `${c.cos.tempPrefix}${hash}_${stem}.jpg`;
    const reused = await objectExists(cos, { bucket: c.cos.bucket, region: c.cos.region, key });
    if (!reused) {
      await uploadFile(cos, { bucket: c.cos.bucket, region: c.cos.region, key, filePath: compPath });
    }
    const signedUrl = await getSignedUrl(cos, {
      bucket: c.cos.bucket, region: c.cos.region, key, expires: c.cos.signExpires,
    });
    return { key, signedUrl, reused };
  }

  // ---- 工具 1：生图 ----
  ctx.tools.register(defineTool({
    name: "image_generate",
    description:
      "调用已配置的生图中转站做文生图 / 图生图。文生图和图生图+URL参考图不产生 COS 用量；仅当参考图是本地文件时才压缩并上传腾讯云 COS。返回生图站的图片链接。",
    parameters: {
      prompt: { type: "string", required: true, description: "生图提示词（描述想要的画面）。" },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description: "图生图参考图：URL（生图站链接或 http 链接，直接用）或本地文件路径（会压缩并上传 COS）。留空即文生图。",
      },
      size: { type: "string", description: "本次分辨率，如 1024x1024；未给时用配置里的默认分辨率。" },
      enhance: { type: "boolean", description: "置 false 则本次不追加 prompt 后缀（默认按配置追加）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "生图站返回的图片链接（主结果）" },
          local_path: { type: "string", description: "仅当返回 base64 时，解码落地的本地文件路径" },
          model: { type: "string", required: true },
          size: { type: "string", required: true },
          suffix_appended: { type: "boolean", description: "是否按配置追加了 prompt 后缀" },
          image_count: { type: "integer", description: "参考图数量" },
          cos_uploads: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: { type: "string", required: true, description: "COS 对象键" },
                signed_url: { type: "string", description: "签名访问 URL" },
              },
            },
            description: "本地参考图上传 COS 的记录（key/签名URL）",
          },
        },
      },
      render(args, value) {
        const lines = [];
        if (value.url) lines.push(`![生成图片](${value.url})`);
        if (value.local_path) lines.push(`本地副本：${value.local_path}`);
        lines.push(`模型 \`${value.model}\` · 尺寸 \`${value.size}\``);
        if (value.suffix_appended) lines.push("已追加 prompt 后缀（印刷级中文守卫）");
        if (value.cos_uploads?.length) lines.push(`参考图已上传 COS：${value.cos_uploads.map((u) => u.key).join("、")}`);
        return lines.join("\n");
      },
    },
    async execute(args) {
      const c = readConfig(config);
      const apiKey = await resolveSecret(ctx, c.provider.apiKey, c.provider.apiKeyEnv);
      if (!apiKey) {
        throw new Error("生图 API Key 未配置：请在设置里填写，或配置 IMAGEGEN_API_KEY 凭证/环境变量。");
      }

      // 尺寸：本次显式指定优先，否则用配置默认分辨率
      const size = resolveSize({ size: args.size, defaultSize: c.provider.defaultSize });

      // prompt 后缀追加（启用时每次提交都追加；enhance:false 本次跳过）
      const { prompt: finalPrompt, appended } = buildPrompt({
        prompt: args.prompt,
        enabled: c.promptEnhance.enabled,
        suffix: c.promptEnhance.suffix,
        skip: args.enhance === false,
      });

      // 参考图分流
      const refs = args.reference_images ?? [];
      const imageUrls = [];
      const imageRefs = [];
      const cosUploads = [];
      const multipart = c.provider.img2imgMode === "edits-multipart";

      for (const ref of refs) {
        if (isUrl(ref)) {
          // URL 参考图：直接用，零 COS
          if (multipart) imageRefs.push({ url: ref });
          else imageUrls.push(ref);
        } else {
          // 本地参考图：压缩
          const localAbs = resolveLocal(ref);
          const comp = await compressImage(localAbs);
          if (multipart) {
            // edits 直接传文件字节，不经过 COS
            imageRefs.push({ path: comp.path });
          } else {
            // image-array：上传 COS 再签名给生图站
            const up = await uploadLocalRef(c, comp.path, ref);
            imageUrls.push(up.signedUrl);
            cosUploads.push({ key: up.key, signed_url: up.signedUrl });
          }
        }
      }

      // 生图
      const result = await generate({
        baseUrl: stripTrailing(c.provider.baseUrl),
        apiKey,
        model: c.provider.model,
        size,
        prompt: finalPrompt,
        n: c.provider.n,
        protocol: c.provider.protocol,
        img2imgMode: c.provider.img2imgMode,
        imageUrls,
        imageRefs,
        pollIntervalMs: c.provider.pollIntervalMs,
        pollTimeoutMs: c.provider.pollTimeoutMs,
        protocolCache,
      });

      const out = {
        url: result.url ?? null,
        model: c.provider.model,
        size,
        suffix_appended: appended,
        image_count: refs.length,
        cos_uploads: cosUploads,
      };
      if (result.b64) {
        // 兜底：返回 base64 时解码落本地
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const dir = join(process.cwd(), "images");
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `gen_${Date.now()}.png`);
        writeFileSync(p, Buffer.from(result.b64, "base64"));
        out.local_path = p;
      }
      return out;
    },
  }));

}
