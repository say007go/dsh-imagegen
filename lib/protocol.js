// 生图协议适配层：标准 OpenAI 同步协议 + 通用异步任务协议（duomi 是任务式的默认示例）。
//
// 自动判定(auto)流程：
//   POST /images/generations?async=true
//   ├─ 响应含 id/task_id          → 异步任务协议，轮询 taskPath（默认 /tasks/{id}）
//   ├─ 响应含 data[].url          → 同步协议，直接取图
//   └─ HTTP 报错(如拒绝 async 参数) → 重试纯同步 POST，取 data[].url
// 检测结果按 baseUrl 缓存，后续调用不再探测。
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { sleep, withTimeout } from "./abort.js";
import { imageExtension, imageMediaType } from "./image-size.js";

function truncate(s, n = 500) {
  return String(s ?? "").slice(0, n);
}

/** 按 taskPath 模板拼任务查询 URL；支持绝对 URL 和 {id} 占位。 */
function taskUrl(baseUrl, taskPath, taskId) {
  const id = encodeURIComponent(taskId);
  const template = String(taskPath || "/tasks/{id}").trim();
  const path = template.includes("{id}")
    ? template.replace(/\{id\}/g, id)
    : `${template.replace(/\/+$/, "")}/${id}`;
  return /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

// 单次请求超时：防止单条请求卡死吃掉整个等待预算
const REQUEST_TIMEOUT_MS = 30000;

async function postJson(url, apiKey, body, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { ok: res.ok, status: res.status, text, json };
}

async function getJson(url, apiKey, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: withTimeout(signal, timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { ok: res.ok, status: res.status, text, json };
}

/** 去掉 data URL 前缀：有些站返回 data:image/png;base64,...。 */
function cleanBase64(value) {
  return String(value ?? "").replace(/^data:[^,]*;base64,/i, "").trim();
}

/** 从任意形状的响应里挖出可用图片（url 或 base64）。 */
export function extractImage(o) {
  if (!o || typeof o !== "object") return undefined;
  const queues = [];
  if (Array.isArray(o.data)) queues.push(o.data);
  if (Array.isArray(o.images)) queues.push(o.images);
  if (o.data && Array.isArray(o.data.images)) queues.push(o.data.images);
  if (o.data && Array.isArray(o.data.data)) queues.push(o.data.data);
  for (const list of queues) {
    for (const item of list) {
      if (typeof item === "string") {
        if (/^https?:\/\//i.test(item)) return { url: item };
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (item.url) return { url: item.url };
      if (item.b64_json) return { b64: cleanBase64(item.b64_json) };
      if (item.b64) return { b64: cleanBase64(item.b64) };
    }
  }
  if (o.url) return { url: o.url };
  if (o.output?.url) return { url: o.output.url };
  if (o.data?.url) return { url: o.data.url };
  if (o.b64_json) return { b64: cleanBase64(o.b64_json) };
  return undefined;
}

async function submitSync(o, genUrl, body) {
  const r = await postJson(genUrl, o.apiKey, body, {
    signal: o.signal,
    timeoutMs: Math.max(REQUEST_TIMEOUT_MS, o.pollTimeoutMs ?? 900000),
  });
  const img = extractImage(r.json);
  if (img) return img;
  throw new Error(`生图同步响应无图片。HTTP ${r.status}：${truncate(r.text)}`);
}

async function pollTask(o, taskId) {
  const startedAt = Date.now();
  const maxWait = o.pollTimeoutMs ?? 900000;
  const deadline = startedAt + maxWait;
  const signal = o.signal;
  // 新任务延迟首查：生成实测普遍 ≥55 秒，提交后立刻轮询纯属空转。
  // 续等（task_id）不再延迟，因为任务早就提交过了。
  let interval = Math.max(2000, o.pollIntervalMs ?? 12000);
  const rawFirstDelay = o.taskId ? 0 : (o.initialPollDelayMs ?? 30000);
  // 至少给第一次轮询留出空间，避免 initialPollDelayMs ≥ pollTimeoutMs 时一次都不查。
  const firstDelay = Math.min(Math.max(0, rawFirstDelay), Math.max(0, maxWait - interval));
  const pollUrl = taskUrl(o.baseUrl, o.taskPath, taskId);
  let failures = 0;
  let lastState = "";
  if (firstDelay > 0) await sleep(firstDelay, signal);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let r;
    try {
      r = await getJson(pollUrl, o.apiKey, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      failures += 1;
      if (failures >= 5) {
        throw new Error(`生图任务轮询连续网络错误（任务ID ${taskId}）：${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(interval, signal);
      interval = Math.min(Math.round(interval * 1.3), 25000);
      continue;
    }
    if (!r.ok) {
      // 连续失败（鉴权/限流）快速报错，不要空等到超时
      failures += 1;
      if (failures >= 5) {
        throw new Error(`生图任务轮询连续失败（HTTP ${r.status}）：${truncate(r.text, 300)}（任务ID ${taskId}）`);
      }
    } else {
      failures = 0;
      const j = r.json;
      const state = String(j?.state ?? j?.status ?? "").toLowerCase();
      if (state) lastState = state;
      // 没有 state 却明确返回错误体：立即失败，不要空转到超时
      if (!state && (j?.error || j?.errors)) {
        throw new Error(`生图任务查询失败：${truncate(JSON.stringify(j.error ?? j.errors), 300)}（任务ID ${taskId}）`);
      }
      if (/fail|error|cancel/.test(state)) {
        throw new Error(`生图任务失败：${truncate(j?.error ?? j?.message ?? r.text, 400)}（任务ID ${taskId}）`);
      }
      // 任何一次响应里出现图片就立即收下（不依赖 state 先翻转）
      const img = extractImage(j);
      if (img) return img;
      if (/succeed|success|complete|finish|done/.test(state)) {
        throw new Error(`生图任务成功但未取到图片：${truncate(r.text, 400)}（任务ID ${taskId}）`);
      }
    }
    await sleep(interval, signal);
    // 轻微退避：12s → 15.6s → 20s → 25s 封顶，兼顾响应速度与服务端压力
    interval = Math.min(Math.round(interval * 1.3), 25000);
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  throw new Error(
    `生图任务等待超时（已等 ${elapsed}s，最后状态 ${lastState || "未知"}）。任务ID：${taskId}。` +
    `该任务可能仍在生成——不要重复提交新任务（会重复计费）；可以稍后用同一 ID 续等（image_generate 传 task_id），或告知用户稍后再试。`,
  );
}

async function generateEdits(o) {
  const url = `${o.baseUrl}/images/edits`;
  const form = new FormData();
  form.append("model", o.model);
  form.append("prompt", o.prompt);
  if (o.size) form.append("size", o.size);
  form.append("n", "1");
  const refs = o.imageRefs ?? [];
  const field = refs.length > 1 ? "image[]" : "image";
  for (const ref of refs) {
    o.signal?.throwIfAborted();
    let bytes, filename;
    if (ref.path) {
      bytes = await readFile(ref.path);
      filename = basename(ref.path);
    } else if (ref.url) {
      const res = await fetch(ref.url, { signal: withTimeout(o.signal, REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`读取参考图失败 HTTP ${res.status}：${truncate(ref.url)}`);
      bytes = Buffer.from(await res.arrayBuffer());
      filename = `reference${imageExtension(bytes) ?? ".jpg"}`;
    } else {
      continue;
    }
    const mediaType = imageMediaType(bytes) ?? ref.mediaType;
    if (!mediaType) throw new Error(`无法识别参考图格式：${ref.url ?? ref.path}`);
    form.append(field, new Blob([bytes], { type: mediaType }), filename);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}` },
    body: form,
    signal: withTimeout(o.signal, Math.max(REQUEST_TIMEOUT_MS, o.pollTimeoutMs ?? 900000)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) throw new Error(`图生图(edits)失败 HTTP ${res.status}：${truncate(text)}`);
  const img = extractImage(json);
  if (img) return img;
  const taskId = json?.id ?? json?.task_id;
  if (taskId) return pollTask(o, taskId);
  throw new Error(`图生图(edits)响应无图片：${truncate(text)}`);
}

/**
 * 提交生图并返回 { url } 或 { b64 }。
 */
export async function generate(o) {
  // 断点续等：给定任务 ID 时不再提交，直接继续等同一任务（避免重复计费）
  if (o.taskId) return pollTask(o, o.taskId);

  // 图生图：edits-multipart 独立通道
  if ((o.imageRefs?.length || o.imageUrls?.length) && o.img2imgMode === "edits-multipart") {
    return generateEdits(o);
  }

  const genUrl = `${o.baseUrl}/images/generations`;
  const body = { model: o.model, prompt: o.prompt, n: 1 };
  if (o.size) body.size = o.size;
  if (o.imageUrls?.length) body.image = o.imageUrls;

  let proto = o.protocol ?? "auto";
  if (proto === "auto" && o.protocolCache?.has(o.baseUrl)) {
    proto = o.protocolCache.get(o.baseUrl);
  }
  if (proto === "duomi-async") proto = "async-task";

  if (proto === "openai-sync") {
    return submitSync(o, genUrl, body);
  }

  // async-task 或 auto：带 async=true 探测
  const submit = await postJson(`${genUrl}?async=true`, o.apiKey, body, { signal: o.signal });
  const taskId = submit.json?.id ?? submit.json?.task_id ?? submit.json?.taskId;
  if (taskId) {
    o.protocolCache?.set(o.baseUrl, "async-task");
    return pollTask(o, taskId);
  }
  const img = extractImage(submit.json);
  if (img) {
    o.protocolCache?.set(o.baseUrl, "openai-sync");
    return img;
  }
  if (proto === "auto" && !submit.ok) {
    // 仅当带 async 参数的提交被拒（非 2xx）时才重试纯同步——
    // 2xx 却解析不出任务/图片的情况不再重发，避免重复计费
    const retry = await submitSync(o, genUrl, body);
    o.protocolCache?.set(o.baseUrl, "openai-sync");
    return retry;
  }
  throw new Error(`生图协议无法解析：提交响应既无任务ID也无图片。HTTP ${submit.status}：${truncate(submit.text)}`);
}
