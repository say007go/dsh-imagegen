# dsh-imagegen

通用文生图 / 图生图 DSH 插件。可配置**任意 OpenAI 兼容生图中转站**（默认 duomi，异步协议自动适配），可配置**腾讯云 COS**（仅图生图本地参考图用到），带**场景预设 / 宽高比 / 中文 prompt 增强 / 参考图压缩省带宽**。

## 能力

- `image_generate` 工具：文生图 / 图生图，返回生图站图片链接
- `imagegen` 技能：内嵌使用说明
- 设置界面（Web → Settings → Plugins）：所有配置可视化填写，密钥脱敏

## 成本设计（省 COS 带宽）

| 场景 | COS 用量 |
|------|---------|
| 文生图 | **0** |
| 图生图 + URL 参考图 | **0**（直接用 URL） |
| 图生图 + 本地参考图 | 1 次压缩上传（sharp 转 JPEG、限边长，省上传+下行带宽+容量） |
| 成品图 | 直接返回生图站链接，**不回传 COS** |

## 安装

在 DSH Web 的 **Plugins** 页，或 profile 里用本地路径安装：

```bash
pnpm add file:/绝对路径/dsh-imagegen
```

安装后在 Plugins 页启用 `imagegen` bundle。

## 配置（Settings → Plugins → imagegen）

### 生图站
- **Base URL**：默认 `https://duomiapi.com/v1`；换中转站改这里
- **API Key**：直接填；留空则用 `IMAGEGEN_API_KEY` 凭证/环境变量
  - 没有 duomi 账号？[点此注册](https://duomiapi.com/user/register?cps=S9hKE2Oq)
- **Model**：默认 `gpt-image-2.5-sunburst`；duomi 已知 `gpt-image-2` / `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`
- **Protocol**：`auto`（默认，自动判定同步/异步）/ `openai-sync` / `duomi-async`
- **img2imgMode**：`image-array`（默认）/ `edits-multipart`

### 腾讯云 COS（仅本地参考图需要）
- Region（如 `ap-guangzhou`）、Bucket（`name-appid`）、SecretId、SecretKey
- 或用环境变量 `TENCENT_COS_SECRET_ID` / `TENCENT_COS_SECRET_KEY`

### 场景预设 / 宽高比 / prompt 增强
- **场景预设**：自建，如 `ppt-slide`（16:9 + 中文印刷级增强）、`social-post`（1:1）、`poster`（3:4）；工具里用 `scenario` 一键套用
- **宽高比预设**：`16:9`→3840x2160、`1:1`→2048x2048 等
- **prompt 增强**：默认 `chineseTextQuality` 在 `auto` 模式下仅当图里要出现中文文字时追加印刷级守卫；可增删改

## 协议兼容

详见 [references/api_reference.md](references/api_reference.md)。核心：`auto` 模式按响应自动区分 duomi 异步任务协议与标准 OpenAI 同步协议，换站通常只需改 baseUrl + key + model。

## 目录

```
dsh-imagegen/
├── package.json          # 包清单，声明 dsh.bundle.patch
├── cordis.patch.yml      # bundle 补丁，插入 imagegen 插件
├── lib/
│   ├── index.js          # 主插件：注册工具 + 内嵌技能
│   ├── config.js         # 配置 schema（设置界面来源）
│   ├── protocol.js       # 生图协议适配（auto 判定同步/异步、图生图双模式）
│   ├── size.js           # 三层尺寸解析 + 宽高比换算
│   ├── prompt.js         # prompt 增强（auto/always/off + 关键词）
│   ├── compress.js       # sharp 参考图压缩
│   └── cos.js            # 腾讯云 COS 上传/签名
├── skills/imagegen/SKILL.md
└── references/api_reference.md
```
