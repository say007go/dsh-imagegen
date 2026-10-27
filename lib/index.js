// dsh-imagegen 主插件：注册 image_generate 工具（使用规则全部写在工具描述里）。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
export const inject = ["tools", "credentials", "workingDirectory"];
// Cordis loader 通过入口导出的 Config schema 校验配置并生成设置表单，必须导出。
export { Config };

const isUrl = (s) => /^https?:\/\//i.test(String(s));
const stripTrailing = (s) => String(s ?? "").replace(/\/+$/, "");
// 对话里上传的图片附件以 sha256:<64 hex> 形式出现，可直接当参考图用
const isAttachmentId = (s) => /^sha256:[0-9a-f]{64}$/i.test(String(s ?? "").trim());

/** 把对话附件 ID 解析成宿主文件路径（attachments 是可选服务，缺失时给明确提示）。 */
function resolveAttachment(ctx, ref) {
  const store = typeof ctx.get === "function" ? ctx.get("attachments") : undefined;
  if (!store || typeof store.imageHostPath !== "function") {
    throw new Error("当前环境不支持附件引用：请先把参考图存成本地文件，再传文件路径或图片 URL。");
  }
  const p = store.imageHostPath({ attachmentId: String(ref).trim() });
  if (!p) throw new Error(`无法定位附件 ${String(ref).slice(0, 18)}…：请改用本地文件路径或图片 URL。`);
  return p;
}

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
      pollIntervalMs: val(config.provider.pollIntervalMs),
      pollTimeoutMs: val(config.provider.pollTimeoutMs),
      initialPollDelayMs: val(config.provider.initialPollDelayMs),
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

/** 相对路径基于会话工作目录解析，而不是宿主进程的 cwd。 */
function resolveLocal(ref, cwd) {
  return isAbsolute(ref) ? ref : join(cwd, ref);
}

export function apply(ctx, config) {
  // 按 baseUrl 缓存探测到的协议，避免每次调用重复探测
  const protocolCache = new Map();

  // 提交前的平台级硬闸：真正发起生图前，弹一次审批（只有"允许一次"才执行）。
  // - 续等（task_id）只是查询，不花钱，不弹窗
  // - 没有 approval 服务的部署自动放行，避免插件在别处直接不可用
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.name !== "image_generate") return next();
    const args = exec.arguments ?? {};
    if (String(args.task_id ?? "").trim()) return next();
    const approval = typeof ctx.get === "function" ? ctx.get("approval") : undefined;
    if (!approval || !exec.agent) return next();

    const size =
      String(args.size ?? "").trim() || `默认（${val(config.provider.defaultSize)}）`;
    const refs = Array.isArray(args.reference_images) ? args.reference_images.length : 0;
    const prompt = String(args.prompt ?? "").replace(/\s+/g, " ").slice(0, 120);
    const zh = `确认生成这张图？尺寸 ${size}${refs ? `，参考图 ${refs} 张` : ""}——${prompt}${prompt.length >= 120 ? "…" : ""}`;
    const en = `Generate image? size ${size}${refs ? `, ${refs} reference image(s)` : ""} — ${prompt}${prompt.length >= 120 ? "…" : ""}`;
    return {
      kind: "ask",
      reason: `image_generate needs user approval before submitting (size=${size}, refs=${refs}): ${prompt}`,
      displayReason: { en, zh },
    };
  });

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
      "调用已配置的生图站做文生图 / 图生图，返回图片链接。\n" +
      "【先在对话展示，再由平台审批】提交前把最终 prompt 全文与尺寸展示给用户（用户没指定尺寸就说明将用默认分辨率），然后直接提交——平台会在真正生成前弹审批框，用户点允许才执行，拒绝则不生成、不扣费。审批被拒时按原因修改 prompt 再提交，不要原样重复提交。\n" +
      "【先告知等待预期】确认后、调用前，先对用户说明「已提交，生成通常需要 1~4 分钟，我会一直等到出图」。提交后工具会先静默约半分钟再开始查询（服务端出图普遍要一分钟以上），这段等待属正常，不要中途打断或重复调用。\n" +
      "【一次只出一张】每次调用只生成一张图。出图后先把结果给用户看，等用户反馈再决定是否换方案；禁止在同一回合连续或并行提交多个变体。\n" +
      "【断点续等，不要重开任务】若上一次调用因超时/中断结束，错误信息里带任务 ID。用户想继续时，用本工具传 task_id 续等同一任务（不要传 prompt），绝不重新生成——重新生成会重复计费。\n" +
      "【尺寸跟随设置】默认分辨率由用户在设置里决定。除非用户明确要求某个尺寸，否则不要传 size，也不要擅自改小或改大。\n" +
      "【成本】文生图与 URL 参考图不产生 COS 用量；仅本地文件参考图会压缩后上传腾讯云 COS。提示词后缀由配置自动追加，无需手写。",
    parameters: {
      prompt: { type: "string", description: "生图提示词（描述想要的画面）。生成新图时必填；仅续等任务（传 task_id）时留空。" },
      task_id: { type: "string", description: "续等已有任务的 ID：传了它就不再提交新任务，只等该任务出图。" },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description:
          "图生图参考图，可多张：URL（直接用）、本地文件路径（自动压缩，按内容去重后上传 COS），" +
          "或对话里上传图片的附件 ID（形如 sha256:…，可直接粘贴，无需先存文件）。" +
          "数组顺序即语义顺序（第 1 张、第 2 张…），建议在 prompt 里逐张说明用途，" +
          "例如「第一张图里的人物穿上第二张图的衣服」「参考第一张的画风、第二张的构图」。留空即文生图。",
      },
      size: {
        type: "string",
        description:
          "本次分辨率，如 1024x1024。**仅在用户明确指定尺寸时才传**；" +
          "不传则一律使用配置里的默认分辨率，不要自行更改尺寸。",
      },
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
          elapsed_ms: { type: "integer", description: "本次调用总耗时（毫秒），含等待出图" },
          cos_uploads: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: { type: "string", required: true, description: "COS 对象键" },
              },
            },
            description: "本地参考图上传 COS 的记录（对象键）",
          },
        },
      },
      // DSH 要求 render 返回“内容块数组”，返回纯字符串会让 content.some 崩溃
      render(args, value) {
        const lines = [];
        if (value.url) lines.push(`![生成图片](${value.url})`);
        if (value.local_path) lines.push(`本地副本：${value.local_path}`);
        const meta = [`模型 \`${value.model}\``, `尺寸 \`${value.size}\``];
        if (typeof value.elapsed_ms === "number") {
          const s = Math.round(value.elapsed_ms / 1000);
          meta.push(`耗时 ${s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`}`);
        }
        lines.push(meta.join(" · "));
        if (value.suffix_appended) lines.push("已追加 prompt 后缀（印刷级中文守卫）");
        if (value.cos_uploads?.length) lines.push(`参考图已上传 COS：${value.cos_uploads.map((u) => u.key).join("、")}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      const startedTs = Date.now();
      const c = readConfig(config);
      // 会话工作目录：相对路径的参考图据此解析；服务不可用时退回宿主 cwd
      let cwd = process.cwd();
      try {
        if (exec?.agent && ctx.workingDirectory?.ensure) {
          cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        }
      } catch { /* 保底 */ }
      const apiKey = await resolveSecret(ctx, c.provider.apiKey, c.provider.apiKeyEnv);
      if (!apiKey) {
        throw new Error("生图 API Key 未配置：请在设置里填写，或配置 IMAGEGEN_API_KEY 凭证/环境变量。");
      }
      // 必须至少有 prompt（生成新图）或 task_id（续等已有任务）
      if (!String(args.task_id ?? "").trim() && !String(args.prompt ?? "").trim()) {
        throw new Error("缺少 prompt：生成新图需要 prompt；若只是继续等待已有任务，请传 task_id。");
      }

      // 尺寸：本次显式指定优先，否则用配置默认分辨率
      const size = resolveSize({ size: args.size, defaultSize: c.provider.defaultSize });

      // ---- 续等模式：传了 task_id 就不再提交，只等已有任务出图 ----
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      if (taskId) {
        const result = await generate({
          baseUrl: stripTrailing(c.provider.baseUrl),
          apiKey,
          taskId,
          pollIntervalMs: c.provider.pollIntervalMs,
          pollTimeoutMs: c.provider.pollTimeoutMs,
          initialPollDelayMs: c.provider.initialPollDelayMs,
          protocolCache,
        });
        const resumed = {
          url: result.url ?? null,
          model: c.provider.model,
          size: c.provider.defaultSize,
          suffix_appended: false,
          image_count: 0,
          cos_uploads: [],
          elapsed_ms: Date.now() - startedTs,
        };
        if (result.b64) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const dir = join(cwd, "images");
          mkdirSync(dir, { recursive: true });
          const p = join(dir, `gen_${Date.now()}.png`);
          writeFileSync(p, Buffer.from(result.b64, "base64"));
          resumed.local_path = p;
        }
        return resumed;
      }

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
      const tempFiles = [];
      const multipart = c.provider.img2imgMode === "edits-multipart";

      try {
        for (const raw of refs) {
          const ref = String(raw);
          if (isUrl(ref)) {
            // URL 参考图：直接用，零 COS
            if (multipart) imageRefs.push({ url: ref });
            else imageUrls.push(ref);
          } else {
            // 本地文件 或 对话附件 ID：都归一到宿主文件路径后压缩
            const fromAttachment = isAttachmentId(ref);
            const localAbs = fromAttachment ? resolveAttachment(ctx, ref) : resolveLocal(ref, cwd);
            const name = fromAttachment ? "attachment.png" : ref;
            const comp = await compressImage(localAbs);
            if (comp.compressed) tempFiles.push(comp.path);
            if (multipart) {
              // edits 直接传文件字节，不经过 COS
              imageRefs.push({ path: comp.path });
            } else {
              // image-array：上传 COS 再签名给生图站
              const up = await uploadLocalRef(c, comp.path, name);
              imageUrls.push(up.signedUrl);
              cosUploads.push({ key: up.key });
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
          protocol: c.provider.protocol,
          img2imgMode: c.provider.img2imgMode,
          imageUrls,
          imageRefs,
          pollIntervalMs: c.provider.pollIntervalMs,
          pollTimeoutMs: c.provider.pollTimeoutMs,
          initialPollDelayMs: c.provider.initialPollDelayMs,
          protocolCache,
        });

        const out = {
          url: result.url ?? null,
          model: c.provider.model,
          size,
          suffix_appended: appended,
          image_count: refs.length,
          cos_uploads: cosUploads,
          elapsed_ms: Date.now() - startedTs,
        };
        if (result.b64) {
          // 兜底：生图站直接返回 base64 时，解码落到会话工作目录
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const dir = join(cwd, "images");
          mkdirSync(dir, { recursive: true });
          const p = join(dir, `gen_${Date.now()}.png`);
          writeFileSync(p, Buffer.from(result.b64, "base64"));
          out.local_path = p;
        }
        return out;
      } finally {
        // 清理本次产生的压缩临时文件
        const { rm } = await import("node:fs/promises");
        await Promise.all(tempFiles.map((p) => rm(p, { force: true }).catch(() => {})));
      }
    },
  }));

}
