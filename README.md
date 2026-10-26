# dsh-imagegen

DSH（DeepSeek Harness）文生图 / 图生图插件：接入**任意 OpenAI 兼容的生图接口**，在对话里一句话出图；可选腾讯云 COS 托管本地参考图，插件详情页自带配置表单，并内嵌 `imagegen` 技能让 Agent 开箱即用。

## 功能特性

### 双模式生图

- **文生图**：自然语言描述 → 图片链接
- **图生图**：参考图可以是 **URL**（直接透传，零 COS）或**本地文件**（自动压缩 → 托管到腾讯云 COS → 签名后交给生图站读取）

### 任意 OpenAI 兼容接口

- **Base URL / API Key / 模型 ID 全部可配**——换中转站只需改这三项，代码不用动
- **协议自动适配**：提交后根据响应自动判断站点类型——
  - 标准 OpenAI 系：同步请求，直接返回图片
  - 异步任务系（如多米）：提交拿任务 ID，再轮询取结果
  - 也可手动钉死 `openai-sync` / `duomi-async`（个别"半标准"站点用）
- 兼容多种返回字段（`url` / `b64_json` / `images[0].url` 等）；返回 base64 时自动解码落地到本地

### 智能省成本的 COS 设计

| 场景 | COS 用量 |
|------|---------|
| 文生图 | **0** |
| 图生图 + 参考图为 URL | **0** |
| 图生图 + 参考图为本地文件 | 压缩后上传 1 次（同一张图不会二次上传） |

- 本地参考图经 **sharp 自动压缩**（转 JPEG、最长边 2048px）——同时省上传带宽、生图站读取流量和存储空间
- **内容寻址 + HEAD 探测**：参考图的 COS key 由文件内容哈希生成；同一张图重复使用时直接复用已有对象，**不再重复上传字节**
- 成品图直接返回生图站链接，**不回传 COS**，不产生额外下行流量

### 提示词后缀

- 可配置一段文本（默认为印刷级中文守卫：*"所有中文内容必须印刷级清晰，笔画完整无残缺……"*），**每次提交自动追加**，中文出图不再乱码
- 设置里可一键关闭；单次生成时 Agent 也可传 `enhance: false` 临时跳过

### 场景预设与尺寸

- **场景预设**（内置 `ppt-slide` / `social-post` / `poster`，可自行增删改）：一键套用分辨率与宽高比
- **宽高比预设**：`16:9` / `1:1` / `3:4` / `9:16` 等，可自行增删改
- 尺寸优先级：本次指定 `size` > 本次 `aspect` > 场景预设 > 默认分辨率（默认 4K；多米系分辨率不分档收费，4K 不加价）

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
| | Model | 输入模型 ID，如 `gpt-image-2.5-sunburst` |
| | 默认分辨率 | 默认 4K，可自行设置 |
| 腾讯云 COS | 启用 / Region / Bucket / SecretId / SecretKey | 仅"本地参考图"场景需要 |
| 提示词后缀 | 启用 / 后缀文本 | 启用后每次提交自动追加 |

> 高级项（协议、图生图模式、轮询参数、场景与宽高比预设列表）有代码默认值，开箱即用；需要调整时编辑安装包中的 `cordis.patch.yml` / 配置层即可。

## 使用

重启后直接在对话里说：

- **"生成一张雨后的上海外滩夜景"** —— 文生图
- **"参考这张图的风格，画一张同系列的……"**（附上图片）—— 图生图
- **"用 ppt-slide 场景生成一张企业培训项目封面"** —— 套用场景预设

插件内嵌 `imagegen` 技能，Agent 自动掌握工具用法、成本规则与防降级护栏（工具不可用时会提示重启，而不是手写脚本）。

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
本地参考图 → sharp 压缩（JPEG / 2048px）
          → 内容哈希生成 COS key → HEAD 探测（存在即复用）
          → 不存在才上传 → 签名 URL
          → 拼接提示词后缀 → 提交生图 → 返回链接
```

## 目录结构

```
dsh-imagegen/
├── package.json          # 声明 dsh.bundle + dsh.client
├── cordis.patch.yml      # bundle 补丁（插入 imagegen 插件）
├── lib/
│   ├── index.js          # 主插件：注册 image_generate 工具 + 内嵌技能
│   ├── client.js         # 插件详情页配置表单（浏览器端）
│   ├── config.js         # 配置 schema
│   ├── protocol.js       # 生图协议适配（同步/异步自动判定、图生图双模式）
│   ├── cos.js            # 腾讯云 COS：压缩上传、签名、幂等探测
│   ├── compress.js       # sharp 参考图压缩
│   ├── prompt.js         # 提示词后缀
│   └── size.js           # 尺寸优先级解析
├── skills/imagegen/SKILL.md   # 内嵌 Agent 技能
└── references/api_reference.md
```

## 安全与费用

- **密钥安全**：COS 建议使用腾讯云**子账号最小权限**密钥（只授 COS 读写），不用主账号密钥；插件界面与对话中永不回显密钥值
- **费用提示**：对象存储（COS）与数据万象（CI）为腾讯云付费服务，使用前请知悉——[COS 计费](https://cloud.tencent.com/document/product/436/16871) ｜ [CI 计费](https://cloud.tencent.com/document/product/460/6970)。按本插件的省成本设计，文生图与 URL 参考图不产生任何 COS 费用

## License

[MIT](LICENSE)
