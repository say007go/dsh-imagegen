// dsh-imagegen 主插件：注册 image_generate 工具（使用规则全部写在工具描述里）。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { Config } from "./config.js";
import { resolveSize } from "./size.js";
import { buildPrompt } from "./prompt.js";
import { compressImage } from "./compress.js";
import { imageSizeLabel } from "./image-size.js";
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

/** 合并调用方信号与单次请求超时。 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 从图片字节嗅探扩展名，避免 base64 一律落成 .png。 */
function imageExtension(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 4) === "GIF8") return ".gif";
  return ".png";
}

/** 写入新文件；目标已存在时明确报错，绝不静默覆盖。 */
function writeNewFile(target, bytes) {
  try {
    writeFileSync(target, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`保存失败：目标文件已存在（${target}）。请换一个 save_path，或先删除旧文件。`);
    }
    throw error;
  }
}

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

  // 确认流程走会话内的 ask_user_question，不注册 tools/pre-execute：
  // 平台审批依赖 approval: ask，在 approval: never 的会话里会被直接拒绝；
  // 会话确认不经过 approval，任何会话都能用。

  /** 把生成结果落到本地：base64 直接写，URL 则下载后写。savePath 为空时只在 base64 情况下落默认目录。 */
  async function materialize(out, result, savePath, cwd, signal) {
    signal?.throwIfAborted();
    if (!out.actual_size && result.width && result.height) {
      out.actual_size = `${result.width}x${result.height}`;
    }
    if (result.b64) {
      const raw = String(result.b64).replace(/^data:[^,]*;base64,/i, "").trim();
      if (!raw) throw new Error("生图站返回了空的 base64 图片数据");
      const bytes = Buffer.from(raw, "base64");
      if (bytes.length === 0) throw new Error("生图站返回的 base64 图片数据无法解码");
      out.actual_size = imageSizeLabel(bytes) ?? out.actual_size;
      const target = savePath
        ? resolveLocal(savePath, cwd)
        : join(cwd, "images", `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${imageExtension(bytes)}`);
      if (savePath && existsSync(target)) {
        throw new Error(`保存失败：目标文件已存在（${target}）。请换一个 save_path，或先删除旧文件。`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeNewFile(target, bytes);
      out.local_path = target;
      return out;
    }
    if (out.url) {
      const explicit = Boolean(savePath);
      const target = explicit ? resolveLocal(savePath, cwd) : null;
      if (explicit && existsSync(target)) {
        throw new Error(`保存失败：目标文件已存在（${target}）。请换一个 save_path，或先删除旧文件。`);
      }
      try {
        const res = await fetch(out.url, { signal: withTimeout(signal, 60000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("下载到的图片为空");
        signal?.throwIfAborted();
        out.actual_size = imageSizeLabel(buf) ?? out.actual_size;
        const finalTarget = explicit
          ? target
          : join(cwd, "images", `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${imageExtension(buf)}`);
        mkdirSync(dirname(finalTarget), { recursive: true });
        writeNewFile(finalTarget, buf);
        out.local_path = finalTarget;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (explicit) {
          throw new Error(`图片已生成，但保存到 ${savePath} 失败：${e.message}。图片链接：${out.url}`);
        }
        // 自动落盘失败不阻断出图：保留 URL，让模型/用户仍能拿到图
      }
    }
    return out;
  }

  // 上传一张本地参考图到 COS 并签名（仅 image-array 模式的本地文件走这里）。
  // key = ref<第几张>_<压缩内容 sha256 前 16 位>：同一位置、同一内容重跑时 key 不变；
  // 先 HEAD 探测，已存在则直接复用签名 URL，不重复上传字节（带宽优先）。
  async function uploadLocalRef(c, compPath, index) {
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
    // 对象名带第几张的编号（ref1_<hash>.jpg、ref2_<hash>.jpg……），日志里能直接对上
    // reference_images 的顺序；不再依赖原文件名，同一个位置换文件名也能复用。
    const key = `${c.cos.tempPrefix}ref${index}_${hash}.jpg`;
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
      "【每次生成前必须会话确认】本工具不弹平台审批框。提交前先把最终 prompt 全文、尺寸与模型展示给用户（用户没指定尺寸就说明将用默认分辨率），并列出参考图来源（第1张=URL/本地路径/附件 ID，多张按顺序；超过 3 张给前 3 张和总数）以及 save_path（如填写）。然后调用 ask_user_question 请用户确认，选项至少包含「确认生成」「修改」「取消」；只有用户明确选择「确认生成」后才能调用本工具。未确认不得提交；用户选择「修改」时按意见改 prompt 并重新确认；选择「取消」则停止。一次确认只生成一张图，改动过的 prompt 必须重新确认，不得复用上一次确认。若当前环境没有 ask_user_question，则用普通对话提问，同样必须等到用户明确确认。续等（传 task_id）只是查询、不重新生成，不需要确认。\n" +
      "【先告知等待预期】用户确认后、调用前，先对用户说明「已提交，生成通常需要 1~4 分钟，我会一直等到出图」。提交后工具会先静默约半分钟再开始查询（服务端出图普遍要一分钟以上），这段等待属正常，不要中途打断或重复调用。\n" +
      "【一次只出一张】每次调用只生成一张图。出图后先把结果给用户看，等用户反馈再决定是否换方案；禁止在同一回合连续或并行提交多个变体。\n" +
      "【断点续等，不要重开任务】若上一次调用因超时/中断结束，错误信息里带任务 ID。用户想继续时，用本工具传 task_id 续等同一任务（不要传 prompt），绝不重新生成——重新生成会重复计费。\n" +
      "【尺寸跟随设置】默认分辨率由用户在设置里决定。除非用户明确要求某个尺寸，否则不要传 size，也不要擅自改小或改大。结果会同时给出请求尺寸与实际尺寸；上游可能降采样。\n" +
      "【结果自带图片】插件会自动把图片保存到本地并返回 local_path（未指定 save_path 时默认落到会话目录的 images/）。出图后请把 local_path 用 `![生成图片](<local_path>)` 放进你的回复，确保对话中直接显示；只发远程 URL 或只依赖工具卡片，在部分界面不会自动显示。save_path 可指定保存位置；目标已存在时会报错，不会覆盖——不要自己用 curl 下载（生图站链接带签名和有效期，curl 容易踩 TLS/引号坑）。\n" +
      "【成本】文生图与 URL 参考图不产生 COS 用量；仅本地文件参考图会压缩后上传腾讯云 COS。提示词后缀由配置自动追加，无需手写。",
    parameters: {
      prompt: { type: "string", description: "生图提示词（描述想要的画面）。生成新图时必填；仅续等任务（传 task_id）时留空。" },
      task_id: { type: "string", description: "续等已有任务的 ID：传了它就不再提交新任务，只等该任务出图。" },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description:
          "图生图参考图，可多张：URL（直接用）、本地文件路径（自动压缩，按内容寻址上传 COS，对象名以 ref1/ref2… 编号），" +
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
      save_path: {
        type: "string",
        description:
          "可选：把生成的图片保存到该路径（相对会话工作目录解析，目录会自动创建；目标已存在时会报错，不会覆盖）。" +
          "不传时默认保存到会话目录的 images/。返回里的 local_path 即实际保存位置，不要自己再下载。",
      },
      enhance: { type: "boolean", description: "置 false 则本次不追加 prompt 后缀（默认按配置追加）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "生图站返回的图片链接（主结果）" },
          local_path: { type: "string", description: "本地副本路径：自动保存到 images/ 或 save_path 指定位置；对话里可直接用它渲染图片" },
          model: { type: "string", required: true },
          size: { type: "string", required: true, description: "请求尺寸（提交给生图站的值；上游可能降采样）" },
          actual_size: { type: "string", description: "实际图片尺寸（读取图片头；纯 URL 结果会尽量用 Range 探测，失败时省略）" },
          suffix_appended: { type: "boolean", description: "是否按配置追加了 prompt 后缀" },
          image_count: { type: "integer", description: "参考图数量" },
          elapsed_ms: { type: "integer", description: "本次调用总耗时（毫秒），含等待出图" },
          cos_uploads: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                index: { type: "integer", required: true, description: "第几张参考图（1 起）" },
                key: { type: "string", required: true, description: "COS 对象键" },
              },
            },
            description: "本地参考图上传 COS 的记录（第几张 + 对象键）",
          },
        },
      },
      // DSH 要求 render 返回“内容块数组”，返回纯字符串会让 content.some 崩溃
      render(args, value) {
        const lines = [];
        if (value.local_path) lines.push(`![生成图片](<${value.local_path}>)`);
        else if (value.url) lines.push(`![生成图片](${value.url})`);
        if (value.local_path) lines.push(`本地副本：${value.local_path}`);
        if (value.local_path && value.url) lines.push(`原图链接：${value.url}`);
        const meta = [`模型 \`${value.model}\``, `请求尺寸 \`${value.size}\``];
        meta.push(value.actual_size ? `实际尺寸 \`${value.actual_size}\`` : "实际尺寸未校验");
        if (typeof value.elapsed_ms === "number") {
          const s = Math.round(value.elapsed_ms / 1000);
          meta.push(`耗时 ${s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`}`);
        }
        lines.push(meta.join(" · "));
        if (value.suffix_appended) lines.push("已追加提示词后缀");
        if (value.cos_uploads?.length) lines.push(`参考图已上传 COS：${value.cos_uploads.map((u) => `第${u.index ?? "?"}张 ${u.key}`).join("、")}`);
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
          signal: exec.signal,
          pollIntervalMs: c.provider.pollIntervalMs,
          pollTimeoutMs: c.provider.pollTimeoutMs,
          initialPollDelayMs: c.provider.initialPollDelayMs,
          protocolCache,
        });
        const resumed = {
          ...(result.url ? { url: result.url } : {}),
          model: c.provider.model,
          size: c.provider.defaultSize,
          suffix_appended: false,
          image_count: 0,
          cos_uploads: [],
          elapsed_ms: Date.now() - startedTs,
        };
        return await materialize(resumed, result, String(args.save_path ?? "").trim(), cwd, exec.signal);
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
        for (const [offset, raw] of refs.entries()) {
          const index = offset + 1; // 1 起，对应“第几张参考图”
          const ref = String(raw);
          if (isUrl(ref)) {
            // URL 参考图：直接用，零 COS
            if (multipart) imageRefs.push({ url: ref });
            else imageUrls.push(ref);
          } else {
            // 本地文件 或 对话附件 ID：都归一到宿主文件路径后压缩
            const fromAttachment = isAttachmentId(ref);
            const localAbs = fromAttachment ? resolveAttachment(ctx, ref) : resolveLocal(ref, cwd);
            const comp = await compressImage(localAbs);
            if (comp.compressed) tempFiles.push(comp.path);
            if (multipart) {
              // edits 直接传文件字节，不经过 COS
              imageRefs.push({ path: comp.path });
            } else {
              // image-array：上传 COS 再签名给生图站
              const up = await uploadLocalRef(c, comp.path, index);
              imageUrls.push(up.signedUrl);
              cosUploads.push({ index, key: up.key });
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
          signal: exec.signal,
          pollIntervalMs: c.provider.pollIntervalMs,
          pollTimeoutMs: c.provider.pollTimeoutMs,
          initialPollDelayMs: c.provider.initialPollDelayMs,
          protocolCache,
        });

        const out = {
          ...(result.url ? { url: result.url } : {}),
          model: c.provider.model,
          size,
          suffix_appended: appended,
          image_count: refs.length,
          cos_uploads: cosUploads,
          elapsed_ms: Date.now() - startedTs,
        };
        return await materialize(out, result, String(args.save_path ?? "").trim(), cwd, exec.signal);
      } finally {
        // 清理本次产生的压缩临时文件
        const { rm } = await import("node:fs/promises");
        await Promise.all(tempFiles.map((p) => rm(p, { force: true }).catch(() => {})));
      }
    },
  }));

}
