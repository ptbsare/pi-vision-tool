# pi-vision-tool

让 **纯文本编码模型"看见"图片** 的 [Pi](https://pi.dev) 扩展：

- **全面透明拦截** —— 用户消息、工具结果（`read` 读图、浏览器截图、`image_generate` 产物）、TUI 粘贴图片，自动描述并注入上下文
- **`describe_image` 工具** —— 模型也可按需显式委托图片分析，走 **pi 官方管线**（`ctx.modelRegistry.complete`），`maxRetries` / `maxRetryDelayMs` 可配置
- **官方 `resizeImage` 自动压缩**，图片大小上限 `maxImageBytes` 可配置
- **多格式** —— PNG/JPEG/GIF/WebP/BMP 原生支持；**HEIC/HEIF/AVIF/TIFF/SVG/ICO** 经自动转码（内置 `heic-convert` + `sharp`，无需任何命令行工具）
- **视觉缓存路径** —— 每次分析都会把分析过的图片持久化到缓存目录并返回路径，模型可继续用 `describe_image` 对同一张图深入分析
- **干净上下文** —— 清除 pi 为纯文本模型自动注入的干扰文本：`(image omitted: model does not support images)` 占位符、`[Image: original WxH, displayed at WxH. Multiply coordinates by …]` 尺寸提示、`[Current model does not support images…]` 警告
- **零配置** —— 自动发现第一个已认证的图像模型，配置失效自动回退；所有设置统一在 `vision-tool.json`

## 工作原理

```
                 ┌────────────────────────────────────────────┐
 用户图片 ──────►│  input       TUI 粘贴 / 路径物化为附件      │
 工具结果 ──────►│  context     用户消息 → <image-analysis>    │──► pi 官方管线
 引用路径 ──────►│  tool_result 工具输出 → 注入分析块          │    (modelRegistry.complete)
                 └────────────────────────────────────────────┘
                                   │
                                   ▼
                    <image-analysis>
                      ...分析描述...
                      cached-at: /tmp/pi-vision-tool-cache/k9x2....png
                      （用该路径 + 具体问题调 describe_image 继续分析）
                    </image-analysis>
```

仅在以下条件全部满足时拦截：

1. 提示词或工具结果确实包含图片（原生附件 / 可读图片路径 / 工具返回的图片）
2. 当前模型**不**声明 `image` 输入
3. 工具已启用且视觉模型可用（或可自动发现）

多模态模型永远不会被拦截。

## 安装

直接从本 GitHub 仓库安装（尚未发布到 npm）：

```bash
pi install git:github.com/ptbsare/pi-vision-tool
```

不安装试用：

```bash
pi -e git:github.com/ptbsare/pi-vision-tool
```

发布到 npm 后，`pi install npm:pi-vision-tool` 同样可用。

### 零配置

首次会话启动时，扩展自动选取注册表中**第一个可用（已认证、支持图像输入）的模型**，写入 `~/.pi/agent/vision-tool.json` 并提示。若配置的模型失效，自动回退到下一个可用模型。

### 配置（`~/.pi/agent/vision-tool.json`）

```jsonc
{
  "enabled": true,
  "provider": "google",              // 视觉模型 provider（models.json）
  "model": "gemini-2.5-flash",      // 必须声明 input: ["text","image"]
  "maxOutputTokens": 4096,          // 视觉调用输出上限
  "maxRetries": 2,                  // 官方管线重试次数
  "maxRetryDelayMs": 5000,          // 官方管线退避上限
  "timeoutSeconds": 120,            // 单次识别超时（秒），0 = 不限制
  "maxImageBytes": 10485760,        // 超过此大小自动压缩（官方 resizeImage）
  "cacheDir": "/tmp/pi-vision-tool-cache", // 分析图片的持久化缓存目录
  "cacheTtlHours": 24,              // 缓存 TTL（0 = 永不清理）
  "autoIntercept": true,            // 透明桥接开关
  "showInFooter": true,              // TUI 底栏指示器
  "convertFormats": ["heic","heif","avif","tiff","tif","svg","ico","jfif"]
}
```

全部有合理默认值 —— 空文件（甚至没有文件）也能直接工作。

### 多格式支持（HEIC 等）

格式由**魔术字节**判定，绝不信任扩展名。原生格式直通视觉模型；HEIC/HEIF/AVIF/TIFF/SVG/ICO 自动转成 JPEG —— **无需任何系统命令行工具**，因为两个解码器都作为依赖内置：

1. **`heic-convert`** —— 纯 JS/WASM，零原生编译解码 HEIC/HEIF
2. **`sharp`** —— 预编译 libvips 二进制（无需本机编译），解码 AVIF/TIFF/SVG/ICO/WebP
3. 系统工具（`magick` / `convert` / `ffmpeg` / `heif-convert` / `sips`）—— 可选的最后兜底

`heic-convert` 和 `sharp` 随包自动安装，HEIC 支持**永远不需要你手动装任何命令行工具**。

## 命令

| 命令 | 说明 |
|---|---|
| `/vision` 或 `/vision status` | 查看当前状态与缓存统计 |
| `/vision set <provider> <model>` | 配置视觉模型 |
| `/vision list` | 列出可用（图像）模型 |
| `/vision on` / `/vision off` | 总开关 |
| `/vision intercept on\|off` | 仅切换自动拦截 |
| `/vision config <key> <value>` | 调 `maxOutputTokens`、`maxRetries`、`maxRetryDelayMs`、`timeoutSeconds`、`maxImageBytes`、`cacheDir`、`cacheTtlHours`、`showInFooter`、`convertFormats` |
| `/vision test [path]` | 端到端管线测试（自动生成测试图） |
| `/vision cache` / `/vision cache clear` | 缓存统计 / 清空 |

## `describe_image` 工具

```
describe_image(image_path, question)
```

- `image_path` —— 绝对路径或工作区相对路径；也可以是之前 `<image-analysis>` 块里的 `cached-at` 路径
- `question` —— 具体问题，如 *"提取第 4 行的错误堆栈"*、*"按钮为什么右移了 10px？"*

### 用缓存路径继续分析

每次自动描述都会附带分析图片的缓存路径：

```
<image-analysis>
...
cached-at: /tmp/pi-vision-tool-cache/k9x2f81a.png
如需进一步分析这张图，用该路径 + 具体问题调 describe_image
（如"逐字提取所有文本"）。
</image-analysis>
```

当首次描述没有覆盖模型所需的信息时，主模型可继续用 `describe_image` 深入分析同一张图 —— 提取文本、查看某个区域、列出 UI 元素等。缓存文件与分析的字节完全一致，每次追问都指向**同一张图**。

## 设计说明

- 所有视觉调用走 **pi 官方管线**：认证、协议（google-generative-ai / openai-completions / anthropic-messages）、重试全由 pi 处理 —— pi 支持的任何 provider（含 OAuth 订阅）都能用
- 单次识别受 `timeoutSeconds` 约束（默认 **120 秒**，`0` 不限制）。超时立即中止并返回清晰错误，不会无限挂起；Ctrl+C 随时可取消
- 用户原始消息永不改写；分析只注入发送给模型的瞬态上下文，原始图片块保留（TUI 照常显示）
- 超大图片先用 pi 官方 `resizeImage` 压到 `maxImageBytes` 再发送
- 单条消息多图按顺序逐张描述，避免并发冲击视觉模型
- 对纯文本模型，扩展在描述后会**从送往 provider 的上下文中移除原始 image 块**，从而阻止 pi-ai 的 `downgradeUnsupportedImages()` 插入 `(image omitted: model does not support images)` 占位符——该占位符仅在 image 块抵达 provider 时才产生。TUI 会话历史保留原始消息，图片照常渲染；多模态模型完全不受影响
- 系统生成的图片提示（`[Image: original …]`、`[Current model does not support images…]`、`[Image converted from …]`）会从用户文本与工具结果中清除，不再干扰模型

## 许可

GPL-3.0-or-later（见 [LICENSE](LICENSE)）
