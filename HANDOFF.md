# dsh-imagegen 交接文档

> 面向后续 Agent / 新开对话。最后更新：2026-10-27。
>
> 运行时版本：**0.7.7**；代码基线：**dd3c764**；分支：**main**。
>
> 本文件是开发交接文档，可能有一笔后续的 `docs:` 提交，代码基线仍以上面的运行时版本/提交为准。
>
> 先读本文件，再读 [README.md](README.md)、[lib/index.js](lib/index.js)、[lib/protocol.js](lib/protocol.js)、[lib/client.js](lib/client.js)。

## 1. 项目定位

DSH（DeepSeek Harness）插件：把 OpenAI 风格/任务式生图接口接进对话，提供 `image_generate` 工具。

核心能力：

- 文生图 / 图生图（URL、本地文件、对话附件 ID）
- 一次生成一张；生成前会话内确认；续等不重复提交
- 本地参考图可压缩后上传腾讯云 COS；URL 参考图零 COS
- 结果自动保存本地副本，最终回复给可点击本地链接
- 请求尺寸与实际尺寸分别返回
- 设置页可配 Base URL、API Key、模型、默认分辨率、COS、Prompt 后缀、协议、图生图模式

插件本身**不依赖模型视觉能力**；视觉质检是可选的 Agent 行为，不是运行前提。

## 2. 当前状态

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/say007go/dsh-imagegen` |
| 分支 | `main`，与 `origin/main` 一致 |
| 版本 | `0.7.7`（`package.json`） |
| 代码基线 | `dd3c764 fix: v0.7.7 - complete 多米API settings labels`（本文档的 docs 提交可能在其后） |
| Tag | 只有 `v0.2.0`～`v0.6.0`；**0.7.x 未打 tag/release** |
| 自动化测试 | 无 `tests/`、无 CI |
| 构建 | 无构建步骤；`lib/client.js` 是手工 `__ModuleLoader__` 模块 |
| 发布 | 从 GitHub `main` 安装/更新；插件页更新后重启 DSH |
| 本机 profile 安装版本 | **0.7.3**，落后于当前仓库，需要更新/重装 |

安装/更新路径：

```text
插件页 → dsh-imagegen → 更新/重装 → 重启 DSH
```

如果更新后仍显示旧版本，删除后重装。

## 3. 必须保留的设计（改前先确认）

这些是用户明确要求或已经验证过的取舍，不要为了“更通用/更顺手”擅自改掉：

1. **生成前确认走会话，不走平台审批**
   - 由 Agent 调 `ask_user_question`；`task_id` 续等豁免。
   - 不注册 `tools/pre-execute`，因为 `approval: never` 的会话会把平台审批自动拒绝。
   - 这是**软确认**：依赖模型遵守工具描述；插件无法硬拦。

2. **一次一张、一次提交**
   - 每次调用只生成一张；禁止同一回合并行提交多个变体。
   - 异步提交只发生一次；续等只轮询，不重新提交。

3. **轮询节奏不要缩短**
   - 新任务首查：`30s`
   - 首次之后间隔：`12s`，轻微退避到 `25s`
   - 总等待：`15min`
   - `task_id` 续等首查立即。
   - 用户明确说过 duomi 平均 1 分钟以上、个别 7～8 分钟；不要改成“提交后立刻轮询/更频繁轮询”。

4. **结果只给本地链接，不做内联预览**
   - 不输出 `![...](path)` markdown 图片。
   - 4K 大图/`vision_present` 的 `replyImage` 在客户端可能显示“图片无法预览”；本地链接稳定可点。
   - 工具卡片是通用纯文本卡片，卡片内可能看到原始 Markdown；最终回复里的链接才是渲染后的可点击链接。
   - 视觉分析可用，但不要把 `vision_present` 的 `replyImage` 当最终预览。

5. **本地全分辨率副本**
   - 未指定 `save_path` 时默认保存到会话目录 `images/`。
   - `save_path` 目标已存在会报错，不静默覆盖。
   - 返回 `local_path`、`actual_size`、原图 URL。

6. **协议默认 duomi 优先，但标准 OpenAI 必须显式同步**
   - `auto`：先发 `POST /images/generations?async=true`，拿 task ID 就轮询。
   - `openai-sync`：跳过 `?async=true`，单次长请求，不轮询。
   - `async-task`：任务式；`taskPath` 默认 `/tasks/{id}`，支持 `{id}` 或完整 URL。
   - `duomi-async` 是 `async-task` 的兼容别名，不要删。
   - 标准 OpenAI 慢同步站如果留在 `auto`，30 秒提交超时可能打断；设置页已经能选 `openai-sync`。

7. **图生图两种模式**
   - `image-array`（默认）：`generations` 请求体里传 `image: [url]`；duomi/兼容站。
   - `edits-multipart`：走 `/images/edits`，multipart 直传；标准 OpenAI。
   - `edits` 已按实际 MIME/filename 发送；多图用 `image[]`，单图用 `image`。

8. **格式必须真实**
   - 本地参考图用 `sharp` 压缩（可选依赖）；没有 sharp 时保留原图。
   - COS key 扩展名、`ContentType`、edits Blob 类型都按实际字节，不伪装成 JPEG。
   - COS 默认 key：`imagegen-input/ref<N>_<hash16>.<ext>`；旧前缀 `duomi-input/` 不再作为默认。

9. **尺寸**
   - `size` 是请求尺寸；`actual_size` 是下载后读图片头的实际尺寸。
   - 支持 PNG/JPEG/GIF/WebP（VP8X/VP8/VP8L）；其它格式可能标记“未校验”。
   - 上游可能降采样，以 `actual_size` 为准。

10. **不依赖视觉插件**
    - 插件不 import `read_image`、`vision_describe` 或任何视觉服务。
    - 没有视觉能力时，生成、保存、链接交付、续等、取消都正常；只是不能自动看画质检。

## 4. 目录与文件地图

```text
dsh-imagegen/
├── HANDOFF.md              # 本文件（开发交接，不随插件发布）
├── README.md               # 用户文档
├── CHANGELOG.md            # 版本变更
├── package.json            # 版本、依赖、DSH bundle/client 声明
├── cordis.patch.yml        # bundle 补丁，插入 imagegen 插件
├── icon.svg                # 插件列表图标
├── screenshots.json        # 商店截图清单（当前 1 张）
├── assets/
│   ├── screenshot-1.png    # 商店截图（浅色配置表单）
│   └── capture-form.html   # 截图工装，仅开发用，不在 files 中
├── references/
│   └── api_reference.md    # API 适配参考
└── lib/
    ├── index.js            # 工具注册、配置读取、参考图分流、落盘、render、execute
    ├── protocol.js         # 同步/异步/edits 协议；taskUrl；响应取图
    ├── config.js           # Schemastery 配置 schema
    ├── client.js           # 插件详情页配置表单（浏览器端）
    ├── compress.js         # 可选 sharp 压缩；媒体类型/扩展名
    ├── cos.js              # COS 上传、HEAD、签名 URL、ContentType
    ├── image-size.js       # 图片头宽高 + MIME/扩展名（无依赖）
    ├── abort.js            # withTimeout / 可取消 sleep
    ├── prompt.js           # Prompt 后缀追加
    └── size.js             # 尺寸字符串规整
```

`package.json` 的 `files` 只包含 `lib/`、`references/`、`icon.svg`、`screenshots.json`、`assets/screenshot-1.png`、`cordis.patch.yml`；`HANDOFF.md` 与 `assets/capture-form.html` 不会进插件安装包。

## 5. 执行流程

```text
execute(args, exec)
  └─ readConfig + workingDirectory + API key
       ├─ task_id? → generate({taskId}) → pollTask
       └─ prompt? → buildPrompt
            → 参考图循环（URL / 本地 / 附件 ID）
            → generate()
                 ├─ img2imgMode=edits-multipart → /images/edits
                 ├─ protocol=openai-sync → 单次同步 POST
                 └─ auto/async-task → ?async=true → taskPath 轮询
            → materialize()
                 ├─ base64 / URL 下载
                 ├─ 实际尺寸 + 本地副本
                 └─ save_path 不覆盖
            → render()
                 └─ 本地链接 + 元数据（不输出 markdown 图片）
```

关键边界：

- 生成前确认由 Agent 按工具描述执行；插件不硬拦截。
- 异步提交后不要重复提交；超时错误里带 task ID，可续等。
- 自动落盘失败不阻断出图，保留原图 URL；显式 `save_path` 失败会报错。
- `elapsed_ms` 是生成阶段耗时，不包含最后落盘/读尺寸的少量时间。

## 6. 配置

设置页（`lib/client.js`）字段：

- 生图中转站：Base URL、API Key、Model、默认分辨率
- 兼容性（高级）：协议、图生图模式
- 腾讯云 COS：启用、Region、Bucket、SecretId、SecretKey
- Prompt 后缀：启用、后缀文本

只走 YAML（`cordis.patch.yml` / 配置层）的字段：

- `provider.taskPath`
- `provider.initialPollDelayMs`
- `provider.pollIntervalMs`
- `provider.pollTimeoutMs`
- `provider.apiKeyEnv`
- `cos.secretIdEnv` / `cos.secretKeyEnv`
- `cos.tempPrefix` / `cos.signExpires`

UI 文案使用 **多米API**；以下保留英文/原值，不要翻译：

- `https://duomiapi.com/v1`（真实域名）
- `duomi-async`（配置值/兼容别名）
- 模型 id / 协议值 / 模式值

## 7. 开发与验证

### 必跑

```bash
cd D:\Projects\Program\dsh-imagegen
git status -sb
for f in lib/*.js; do node --check "$f" || exit 1; done
git diff --check
npm pack --dry-run --json
```

### 截图工装

`assets/capture-form.html` 用真实 `lib/client.js` + mock 配置渲染配置表单。优先用 Playwright；如果没有 headless Chromium，可用本机 Edge 的 `executable_path`：

```python
from playwright.sync_api import sync_playwright
from pathlib import Path
url = Path("assets/capture-form.html").resolve().as_uri()
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)  # 若无 headless shell，加 executable_path=...
    pg = b.new_page(viewport={"width": 1280, "height": 1100})
    pg.goto(url); pg.wait_for_timeout(500)
    pg.screenshot(path="assets/screenshot-1.png", full_page=True)
    b.close()
```

截图要求：浅色背景、无版本号、1280 宽、完整页面。改设置 UI 后必须重新生成。

### 已验证过的临时测试

之前用本地 HTTP mock / 直接 import 做过：

- `image-size`：JPEG 2000×1125、PNG、GIF、WebP VP8X/VP8/VP8L
- `compressImage`：无 sharp 时返回原图 + 正确 MIME/扩展名
- `generateEdits`：多图发送 `image[]` ×2，JPEG/PNG `Content-Type` 正确
- `generate`：自定义 `taskPath=/custom/{id}` 与默认 `/tasks/{id}` 都命中
- `sleep`/取消：已中止信号立即 reject

**没有保留为 `tests/` 文件，也没有 CI。** 后续如果继续迭代，建议优先补：

- `tests/image-size.test.mjs`（纯函数）
- `tests/protocol.test.mjs`（本地 HTTP mock：edits 字段、taskPath、超时/取消）
- `tests/prompt-size.test.mjs`（纯函数）

### 未验证/需要真实环境确认

- 0.7.5+ 设置页的 `.volatile()` union 字段在真实 DSH 配置页中的显示（截图工装是 mock，不是真实配置页）
- 0.7.7 更新后的真实生图全链路（本机 profile 仍是 0.7.3）
- 不同生图站的 `auto`/`openai-sync`/`async-task` 行为

## 8. 已知问题与 backlog

按优先级/影响排列：

1. **`compress.js` 的 `before/after` 是死数据**
   - 计算并返回，但没有调用方读取；可删 `stat` 与这两个字段。

2. **`taskPath` 仍只在 YAML**
   - 标准 OpenAI 不需要；其它任务式站点要编辑配置层。
   - 如果以后要支持更多异步站，可考虑加设置页文本框。

3. **异步提交参数固定为 `?async=true`**
   - `taskPath` 只解决轮询路径；如果某站的异步提交参数/方式不同，仍不支持。
   - 不要轻易加太多模式；优先文档说明或增加一个 `asyncQuery` 高级项。

4. **`auto` 仍是 duomi 优先**
   - 标准 OpenAI 慢同步站必须选 `openai-sync`；否则 30 秒提交超时可能打断。
   - 设置页已经暴露协议，不要改默认把 duomi 主路径弄坏。

5. **`image-array` 仍是默认图生图模式**
   - 标准 OpenAI 要切 `edits-multipart`。

6. **Agent 仍可能主动用 `vision_present`**
   - 插件已经只输出本地链接、不输出 markdown 图片；工具描述也禁止复制 `replyImage`。
   - 但外部视觉工具由 Agent 自己调用，插件无法硬拦。若再出现“图片无法预览”，先检查 Agent 是否贴了 4K `replyImage`。

7. **文件/URL 安全边界**
   - `save_path` 和本地参考图走原生 `node:fs`，可越过 DSH 文件沙箱；
   - `edits-multipart` 下载 URL 参考图没有大小/内网地址限制（SSRF/资源消耗风险）。
   - 正常可信使用没问题；如果 prompt 可能被注入，需要后续加沙箱/URL allowlist/大小上限。

8. **没有自动化测试/CI**
   - 见第 7 节建议；这是目前最值得补的工程项。

9. **0.7.x 没有 tag/release**
   - 只有 v0.2.0～v0.6.0 tag；安装走 `main`。
   - 需要正式版本时，先更新 CHANGELOG、打 tag、推 tag，再在 GitHub 建 release。

10. **COS 生命周期未配置**
    - `imagegen-input/` 的临时参考图不会自动清理；建议在 COS 桶配 7 天 lifecycle。

11. **Profile 里有明文密钥**
    - `~/.dsh/profiles/desktop/cordis.patch.yml` 里是直接填写的 API/COS 密钥；不要复制进仓库/日志/文档。
    - 如果这些是真实密钥，建议轮换，并改用 `apiKeyEnv` / `secretIdEnv` / `secretKeyEnv` + 环境变量/凭证库。

12. **设置页文案**
    - 可见品牌名是“多米API”；`duomiapi.com` 域名和 `duomi-async` 配置值保留英文，不要“翻译”。

## 9. 发布流程

1. 改代码/文档/截图
2. 更新 `package.json` 版本 + `CHANGELOG.md`
3. 重跑截图工装（如果 UI 变化）
4. `node --check`、`git diff --check`、`npm pack --dry-run`
5. commit（提交信息保持 `fix: vX.Y.Z - ...` / `feat: ...` 风格）
6. push `main`
7. 可选：打 `vX.Y.Z` tag 并建 GitHub release
8. 用户侧：插件页更新/重装 → 重启 DSH

不要 force push；不要提交 `node_modules/`、`images/`、日志、profile 密钥。

## 10. 新 Agent 第一小时建议

1. 读本文件 + `README.md`
2. `git status -sb`，确认是否在 `main`、是否有未提交改动
3. 读 `lib/index.js` 的 `execute` / `materialize` / `render`
4. 读 `lib/protocol.js` 的 `pollTask` / `generateEdits` / `generate`
5. 读 `lib/client.js` 的配置表单（尤其 `protocol` / `img2imgMode`）
6. 跑第 7 节的必跑检查
7. 不要先改轮询参数、确认方式、markdown 预览策略；这些是用户明确要求
8. 要动协议/格式/依赖前，先确认是否影响 duomi 主路径和 `openai-sync` / `edits-multipart` 两条逃生通道

## 11. 一句话交接

> 这是一个“duomi 优先、但保留标准 OpenAI 逃生口”的 DSH 生图插件；当前最重要的是**别缩短 30s/12s/15min 轮询、别恢复 markdown 图片预览、别把 sharp/协议默认改坏**。其余 backlog 按第 8 节逐项处理。
