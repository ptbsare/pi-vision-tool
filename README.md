# pi-vision-tool

A [Pi](https://pi.dev) extension that gives **text-only coding models vision**:

- **Full transparent interception** — images in user messages, tool results (`read` on an image, browser screenshots, `image_generate` output) and TUI-pasted images are automatically described and injected into context
- **`describe_image` tool** — the model can also explicitly delegate image analysis on demand, through **pi's official pipeline** (`ctx.modelRegistry.complete`) with configurable `maxRetries` / `maxRetryDelayMs`
- **Official `resizeImage` auto-compression** with a configurable size cap (`maxImageBytes`)
- **Multi-format** — PNG/JPEG/GIF/WebP/BMP natively; **HEIC/HEIF/AVIF/TIFF/SVG/ICO** via automatic conversion (bundled `heic-convert` + `sharp`, no CLI tools needed)
- **Vision-cache paths** — every analysis persists the analyzed image to a cache directory and returns its path, so the model can keep asking questions about the same image with `describe_image`
- **Zero-config** — auto-discovers the first authenticated image-capable model, with automatic fallback when it becomes unavailable; all settings live in a single `vision-tool.json`

## How it works

```
                 ┌────────────────────────────────────────────┐
 user image ────►│  input       TUI paste / path materialize │
 tool result ───►│  context     user messages → <image-      │──► pi official pipeline
 referenced ────►│  tool_result tool outputs  → analysis>   │      (modelRegistry.complete)
                 └────────────────────────────────────────────┘
                                   │
                                   ▼
                    <image-analysis>
                      ...description...
                      cached-at: /tmp/pi-vision-tool-cache/k9x2....png
                      (call describe_image with this path and a
                       specific question to analyze the image further)
                    </image-analysis>
```

The bridge only runs when **all** of the following hold:

1. the prompt/tool result actually contains images (native attachments, readable image file paths, or tool-returned image content)
2. the active model does **not** declare `image` input support
3. the tool is enabled and a vision model is available (or auto-discoverable)

Multimodal models are never intercepted.

## Install

Install directly from this GitHub repository (the package is not published to npm yet):

```bash
pi install git:github.com/ptbsare/pi-vision-tool
```

Or try without installing:

```bash
pi -e git:github.com/ptbsare/pi-vision-tool
```

Once published to npm, `pi install npm:pi-vision-tool` will work too.

### Zero-config

On first session start, the extension picks the **first available (authenticated, image-capable) model** from your registry, writes it to `~/.pi/agent/vision-tool.json` and notifies you. If the configured model ever becomes unavailable, it silently falls back to the next available one.

### Configuration (`~/.pi/agent/vision-tool.json`)

```jsonc
{
  "enabled": true,
  "provider": "google",              // vision provider (models.json)
  "model": "gemini-2.5-flash",      // must declare input: ["text","image"]
  "maxOutputTokens": 4096,          // vision call output cap
  "maxRetries": 2,                  // official-pipeline retry count
  "maxRetryDelayMs": 5000,          // official-pipeline backoff ceiling
  "maxImageBytes": 10485760,        // images above this are auto-resized (official resizeImage)
  "cacheDir": "/tmp/pi-vision-tool-cache", // where analyzed images are persisted
  "cacheTtlHours": 24,              // cache entry TTL (0 = never prune)
  "autoIntercept": true,            // transparent bridging on/off
  "showInFooter": true,              // TUI footer indicator
  "convertFormats": ["heic","heif","avif","tiff","tif","svg","ico","jfif"]
}
```

Everything has a sensible default — an empty file (or no file at all) just works.

### Multi-format support (HEIC & friends)

Format is detected from **magic bytes**, never from the file extension. Native formats go straight to the vision model. HEIC/HEIF/AVIF/TIFF/SVG/ICO are converted to JPEG automatically — **no system tools required**, because both converters ship as dependencies:

1. **`heic-convert`** — pure JS/WASM, decodes HEIC/HEIF with zero native compilation
2. **`sharp`** — prebuilt libvips binaries (no build step), decodes AVIF/TIFF/SVG/ICO/WebP
3. system tools (`magick` / `convert` / `ffmpeg` / `heif-convert` / `sips`) — optional last-resort fallback

`heic-convert` and `sharp` are installed automatically with the package; you never have to install a CLI tool for HEIC support.

## Commands

| Command | Description |
|---|---|
| `/vision` or `/vision status` | Show current status + cache stats |
| `/vision set <provider> <model>` | Configure the vision model |
| `/vision list` | List available (image-capable) models |
| `/vision on` / `/vision off` | Enable / disable everything |
| `/vision intercept on\|off` | Toggle automatic interception only |
| `/vision config <key> <value>` | Tune `maxOutputTokens`, `maxRetries`, `maxRetryDelayMs`, `maxImageBytes`, `cacheDir`, `cacheTtlHours`, `showInFooter`, `convertFormats` |
| `/vision test [path]` | End-to-end pipeline test (auto-generates a test image) |
| `/vision cache` / `/vision cache clear` | Cache stats / wipe the cache |

## The `describe_image` tool

```
describe_image(image_path, question)
```

- `image_path` — absolute or workspace-relative path; may also be a `cached-at` path from a previous `<image-analysis>` block
- `question` — a specific question, e.g. *"extract the stack trace shown in line 4"* or *"why is the button shifted 10px to the right?"*

### Follow-up analysis via cached paths

Every automatic description embeds the analyzed image's cache path:

```
<image-analysis>
...
cached-at: /tmp/pi-vision-tool-cache/k9x2f81a.png
For further analysis of this exact image, call describe_image with
image_path="/tmp/pi-vision-tool-cache/k9x2f81a.png" and a specific
question (e.g. "extract all text verbatim").
</image-analysis>
```

The main model can therefore keep working on the same image with `describe_image` — extract the text, read a specific region, list UI elements — whenever the initial description doesn't cover what it needs. Since the cached file is byte-identical to what was analyzed, every follow-up refers to the *same* image.

## Design notes

- All vision calls cross **pi's official pipeline**, so auth, protocol (google-generative-ai / openai-completions / anthropic-messages) and retries are handled by pi itself — any provider pi supports works here, including OAuth-based ones.
- The user's original message is never rewritten; analysis is only prepended to the transient provider-bound context, and original image blocks are kept so the TUI still renders them.
- Oversized images are compressed with pi's official `resizeImage` to `maxImageBytes` before being sent.
- Multiple images in one message are described sequentially to avoid bursting the vision provider.

## License

GPL-3.0-or-later (see [LICENSE](LICENSE))
