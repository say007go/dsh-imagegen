# dsh-imagegen

DSH（DeepSeek Harness）文生图 / 图生图插件：接入**任意 OpenAI 兼容的生图接口**，在对话里一句话出图；可选腾讯云 COS 托管本地参考图，插件详情页自带配置表单；生成前用 `ask_user_question` 让你确认、一次只出一张等使用规则直接写在工具描述里，Agent 开箱即守规矩。

## 功能特性

### 双模式生图

- **文生图**：自然语言描述 → 图片链接
- **断点续等**：生成超时或被中断时，可凭任务 ID 继续等待同一张图，不重复提交、不重复计费
- **提交前会话确认**：真正生成前先用 `ask_user_question` 请你确认提示词全文、尺寸/模型、参考图来源（URL/本地路径/附件 ID）和 `save_path`（如填写），选「确认生成」才执行；取消或修改不扣费。确认走会话，不经过 DSH 审批，因此 `approval: never` 的会话也能用
- **图生图**：参考图可以是 **URL**（直接透传）、**本地文件**（先自动压缩，再托管到腾讯云 COS 供生图站读取）或**对话里上传图片的附件 ID**（形如 `sha256:…`，无需先存文件）；本地路径支持绝对路径，相对路径按**会话工作目录**解析
- **多图顺序可追溯**：本地参考图上传 COS 时对象名按 `ref1` / `ref2`… 编号，返回的 `cos_uploads` 带 `index`，日志里能直接对上第几张图
- **save_path 不覆盖**：指定路径已存在时会报错，避免误覆盖；需要覆盖请先删除旧文件
- 成品图直接返回生图站链接

### 任意 OpenAI 兼容接口

- **Base URL / API Key / 模型 ID 全部可配**——换中转站只需改这三项，代码不用动
- **协议自动适配**：提交后根据响应自动判断站点类型——
  - 标准 OpenAI 系：同步请求，直接返回图片
  - 异步任务系（如多米）：提交拿任务 ID，再轮询取结果
  - 也可手动钉死 `openai-sync` / `duomi-async`（个别"半标准"站点用）
- 兼容多种返回字段（`url` / `b64_json` / `images[0].url` 等）；返回 base64 时自动解码落地到本地

### 提示词后缀

- 可配置一段文本（默认内容见设置），**每次提交自动追加**；它只作用于生图请求，不会出现在模型生成的 prompt 或工具参数里，结果里只提示是否追加
- 设置里可一键关闭；单次生成时 Agent 也可传 `enhance: false` 临时跳过

### 尺寸

- 表单里的**默认分辨率**作为兜底（默认 4K，多米系分辨率不分档收费）；单次生成可临时指定任意分辨率
- 结果里的 `size` 是**请求尺寸**；`actual_size` 是**实际图片尺寸**。纯 URL 结果会用 Range 请求读图片头，失败时标注“实际尺寸未校验”；上游可能降采样，以 `actual_size` 为准

### 配置与安全

- 配置表单就在**插件详情页**，修改即时保存、即时生效
- API Key / SecretId / SecretKey 均为**只写输入**：界面只显示"已设置 / 未设置"，密钥永不回传前端、不在对话中回显

## 安装

### 方式一：DSH 界面安装（推荐）

1. 打开 DSH 左侧栏 **插件** → 右上角 **添加插件**
2. 输入本仓库地址：

   ```
   https://github.com/say007go/dsh-imagegen
   ```

3. 安装源可按网络情况选择（如"中国大陆镜像源"）
4. 点击 **安装**，完成后启用 `dsh-imagegen`，**重启 DSH** 生效

### 方式二：命令行

```bash
dsh plugin --profile <你的profile名> add github:say007go/dsh-imagegen
```

安装完成后重启 DSH。

## 配置

重启后进入 **插件 → dsh-imagegen 详情页**，直接填写：

| 分组 | 字段 | 说明 |
|------|------|------|
| 生图接口 | Base URL | 默认多米API，可自行更换API平台 |
| | API Key | 没有 Key？[点击注册多米API](https://duomiapi.com/user/register?cps=S9hKE2Oq) |
| | Model | 输入模型 ID，默认 `gpt-image-2.5-flare`（速度较快），也可换其他模型 |
| | 默认分辨率 | 默认 4K，可自行设置 |
| 腾讯云 COS | 启用 / Region / Bucket / SecretId / SecretKey | 仅"本地参考图"场景需要 |
| 提示词后缀 | 启用 / 后缀文本 | 启用后每次提交自动追加 |

> 高级项（协议、图生图模式、轮询参数）有代码默认值，开箱即用；需要调整时编辑安装包中的 `cordis.patch.yml` / 配置层即可。

## 使用

重启后直接在对话里说：

- **"生成一张雨后的上海外滩夜景"** —— 文生图
- **"参考这张图的风格，画一张同系列的……"**（附上图片）—— 图生图
- **"生成 1024x1024 的方形图标"** —— 临时指定尺寸
- **"生成一张封面图并存到 artifacts/cover.png"** —— 直接保存到指定路径

工具描述里内置了使用规则：**每次生成前先用 `ask_user_question` 确认**、一次只出一张、等待期间不重复提交、超时不重开新任务。

> 确认是会话内的提问卡片，不是 DSH 审批框；续等（`task_id`）只是查询，不弹确认。

## 工作原理

### 协议自动适配

```
POST {baseUrl}/images/generations?async=true
├─ 响应含任务 ID        → 异步协议：轮询 {baseUrl}/tasks/{id} 直到完成
├─ 响应直接含图片       → 同步协议：立即返回
└─ 接口拒绝 async 参数  → 自动降级为纯同步请求重试
```

探测结果按站点缓存，同一站只探测一次。

### 图生图的两种传参

| 模式 | 机制 | 适用 |
|------|------|------|
| `image-array`（默认） | 参考图以 URL 形式随请求提交 | 多米及多数兼容站 |
| `edits-multipart` | 参考图以文件字节直传，完全不经过 COS | 严格走 OpenAI `/images/edits` 的站 |

### 提交前处理链

```
本地参考图 → sharp 压缩（JPEG / 2048px）→ 上传 COS → 签名 URL
          → 拼接提示词后缀 → 提交生图 → 返回链接
```

## 目录结构

```
dsh-imagegen/
├── package.json          # 声明 dsh.bundle + dsh.client + icon
├── icon.svg              # 插件列表/详情页图标（替换同名文件即可换图）
├── assets/screenshot-1.png  # 商店截图（浅色配置表单）
├── screenshots.json      # 商店截图清单
├── cordis.patch.yml      # bundle 补丁（插入 imagegen 插件）
├── lib/
│   ├── index.js          # 主插件：注册 image_generate 工具（含使用规则）
│   ├── client.js         # 插件详情页配置表单（浏览器端）
│   ├── config.js         # 配置 schema
│   ├── protocol.js       # 生图协议适配（同步/异步自动判定、图生图双模式）
│   ├── cos.js            # 腾讯云 COS：压缩上传与签名
│   ├── compress.js       # sharp 参考图压缩
│   ├── prompt.js         # 提示词后缀
│   ├── image-size.js     # 从图片头读实际尺寸（PNG/JPEG/GIF/WebP）
│   └── size.js           # 尺寸解析
└── references/api_reference.md
```

> 图标：根目录 `icon.svg`，由 `package.json` 的顶层 `icon` 字段声明；DSH 插件列表会把它转成 data URL 显示。替换同名文件即可换图，建议 1:1、64×64 或更大。

## 安全与费用

- **密钥安全**：COS 建议使用腾讯云**子账号最小权限**密钥（只授 COS 读写），不用主账号密钥；插件界面与对话中永不回显密钥值
- **费用提示**：对象存储（COS）与数据万象（CI）为腾讯云付费服务，使用前请知悉——[COS 计费](https://cloud.tencent.com/document/product/436/16871) ｜ [CI 计费](https://cloud.tencent.com/document/product/460/6970)

## License

[MIT](LICENSE)
