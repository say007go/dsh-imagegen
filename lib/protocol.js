// 生图协议适配层：让插件兼容 duomi 私有异步协议 + 标准 OpenAI 同步协议。
//
// 自动判定(auto)流程：
//   POST /images/generations?async=true
//   ├─ 响应含 id/task_id          → 异步协议，轮询 /tasks/{id}
//   ├─ 响应含 data[].url          → 同步标准，直接取图
//   └─ HTTP 报错(如拒绝 async 参数) → 重试纯同步 POST，取 data[].url
// 检测结果按 baseUrl 缓存，后续调用不再探测。
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncate(s, n = 500) {
  return String(s ?? "").slice(0, n);
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { ok: res.ok, status: res.status, text, json };
}

async function getJson(url, apiKey) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { ok: res.ok, status: res.status, text, json };
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
      if (!item || typeof item !== "object") continue;
      if (item.url) return { url: item.url };
      if (item.b64_json) return { b64: item.b64_json };
      if (item.b64) return { b64: item.b64 };
    }
  }
  if (o.url) return { url: o.url };
  if (o.output?.url) return { url: o.output.url };
  if (o.data?.url) return { url: o.data.url };
  if (o.b64_json) return { b64: o.b64_json };
  return undefined;
}

async function submitSync(o, genUrl, body) {
  const r = await postJson(genUrl, o.apiKey, body);
  const img = extractImage(r.json);
  if (img) return img;
  throw new Error(`生图同步响应无图片。HTTP ${r.status}：${truncate(r.text)}`);
}

async function pollTask(o, taskId) {
  const deadline = Date.now() + (o.pollTimeoutMs ?? 300000);
  const interval = o.pollIntervalMs ?? 3000;
  const pollUrl = `${o.baseUrl}/tasks/${encodeURIComponent(taskId)}`;
  while (Date.now() < deadline) {
    const r = await getJson(pollUrl, o.apiKey);
    const j = r.json;
    const state = String(j?.state ?? j?.status ?? "").toLowerCase();
    if (/fail|error|cancel/.test(state)) {
      throw new Error(`生图任务失败：${truncate(j?.error ?? j?.message ?? r.text, 400)}`);
    }
    const done = /succeed|success|complete|finish|done/.test(state) || state === "";
    if (done) {
      const img = extractImage(j);
      if (img) return img;
      if (state !== "") throw new Error(`生图任务成功但未取到图片：${truncate(r.text, 400)}`);
    }
    await sleep(interval);
  }
  throw new Error(`生图轮询超时（${o.pollTimeoutMs ?? 300000}ms）`);
}

async function generateEdits(o) {
  const url = `${o.baseUrl}/images/edits`;
  const form = new FormData();
  form.append("model", o.model);
  form.append("prompt", o.prompt);
  if (o.size) form.append("size", o.size);
  form.append("n", String(o.n ?? 1));
  for (const ref of o.imageRefs ?? []) {
    let bytes, filename;
    if (ref.path) {
      bytes = await readFile(ref.path);
      filename = basename(ref.path);
    } else if (ref.url) {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`读取参考图失败 HTTP ${res.status}：${truncate(ref.url)}`);
      bytes = Buffer.from(await res.arrayBuffer());
      filename = "reference.jpg";
    } else {
      continue;
    }
    form.append("image", new Blob([bytes], { type: "image/jpeg" }), filename);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}` },
    body: form,
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
  // 图生图：edits-multipart 独立通道
  if ((o.imageRefs?.length || o.imageUrls?.length) && o.img2imgMode === "edits-multipart") {
    return generateEdits(o);
  }

  const genUrl = `${o.baseUrl}/images/generations`;
  const body = { model: o.model, prompt: o.prompt, n: o.n ?? 1 };
  if (o.size) body.size = o.size;
  if (o.imageUrls?.length) body.image = o.imageUrls;

  let proto = o.protocol ?? "auto";
  if (proto === "auto" && o.protocolCache?.has(o.baseUrl)) {
    proto = o.protocolCache.get(o.baseUrl);
  }

  if (proto === "openai-sync") {
    return submitSync(o, genUrl, body);
  }

  // duomi-async 或 auto：带 async=true 探测
  const submit = await postJson(`${genUrl}?async=true`, o.apiKey, body);
  const taskId = submit.json?.id ?? submit.json?.task_id ?? submit.json?.taskId;
  if (taskId) {
    o.protocolCache?.set(o.baseUrl, "duomi-async");
    return pollTask(o, taskId);
  }
  const img = extractImage(submit.json);
  if (img) {
    o.protocolCache?.set(o.baseUrl, "openai-sync");
    return img;
  }
  if (proto === "auto") {
    // 该站可能拒绝 async 参数，重试纯同步
    const retry = await submitSync(o, genUrl, body);
    o.protocolCache?.set(o.baseUrl, "openai-sync");
    return retry;
  }
  throw new Error(`生图协议无法解析：提交响应既无任务ID也无图片。HTTP ${submit.status}：${truncate(submit.text)}`);
}
