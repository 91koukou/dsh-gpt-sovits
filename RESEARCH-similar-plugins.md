# DSH 文字转语音（TTS）同类插件调研清单

调研时间：2026-10-02 · 目标：为 DSH 接入 **GPT-SoVITS**
证据来源：`registry.npmjs.org`（可直接取到每个版本的完整 `package.json`、README、`dsh.client` 声明与 tarball）、`api.github.com`、以及**本机 DSH 自身源码**（`app.asar` 解包核对）。

> npm 网页版被 Cloudflare 拦截（403），因此所有 npm 侧事实均来自 registry API 原始 JSON，而非页面抓取。

---

## 一、结论先说

1. **`dsh-gpt-sovits`、`dsh-sovits` 在 npm 上都是 404** —— 以 GPT-SoVITS 为引擎、且带完整 GUI（逐条朗读按钮 + 自动朗读 + 设置面板）的插件**不存在**。
2. 唯一真正对接 GPT-SoVITS 的 DSH 插件是 **`dsh-say`**，但它只有 agent 工具（`tts_speak` / `tts_report`），**没有界面按钮、不会自动朗读**。
3. 界面做得最好的是 **`dsh-gsv-tts`**，但它的本地引擎是 **GSV-TTS-Lite**（GPT-SoVITS 的衍生分支），**不是上游 GPT-SoVITS**。
4. 因此「上游 GPT-SoVITS + 完整 GUI」这个位置是空的 —— 这就是 `dsh-gpt-sovits` 的立足点。

---

## 二、DSH 生态（本机可安装）

| 插件 | 引擎 | 逐条 🔊 朗读按钮 | 自动朗读 | 设置面板 | 许可证 / 状态 |
|---|---|---|---|---|---|
| [`dsh-say`](https://github.com/fangqian616/dsh-say) | **GPT-SoVITS**（本机检出或已运行 API）+ 内置 SAPI + ONNX | ❌ | ❌ | ❌ | MIT(npm)/NOASSERTION(GitHub)，v0.1.0，0★ |
| [`dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv) | GSV-TTS-Lite 本地 `:9880` 真流式 + Edge 云端 | ✅ | ✅ | ✅ | MIT，v4.1.0，8 个版本/6 天 |
| [`dsh-fish-tts`](https://github.com/MaRi23333/dsh-fish-tts) | Fish Audio 云端 API（自备 Key，AES-256-GCM 加密存储） | ✅ | ✅ | ✅ | MIT，v0.2.11 |
| [`dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat) | Edge TTS / 小米 MiMo / 自定义 OpenAI 兼容 | ✅ | ✅ | ✅ | MIT，v0.3.1，含语音输入(STT) |
| [`dsh-xiaomi-tts`](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) | MiMo TTS + 浏览器兜底 | ✅ | — | — | MIT，v3.0.8 |
| [`@goodandready/dsh-tts`](https://github.com/GooDAnDReaDY/dsh-tts) | 多引擎链：OpenAI/ElevenLabs/Google/Azure/Groq/Deepgram/Edge/Piper/eSpeak | ✅ | — | — | MIT，v0.4.26，~4.8k 下载/月 |
| [`dsh-audiogen`](https://github.com/shimingming520/dsh-audiogen) | OpenAI 兼容 / ElevenLabs / MiniMax / Stability | 工具+面板 | — | ✅ | Apache-2.0，v0.4.26 |
| [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) | 本地 zipformer2 ASR → Edge TTS / 本地 VITS·Kokoro | ✅ | ✅ | ✅ | MIT，v0.7.18，全双工 |
| [`dsh-tts`](https://github.com/dushaobindoudou/dsh-plugin) | — | — | — | — | **占位包**：v0.0.1「仅占名，首个版本开发中」 |
| **`dsh-gpt-sovits`（本插件）** | **GPT-SoVITS** | ✅ | ✅ | ✅ | MIT，本机实测 |

另有约 15 个二级包（`dsh-voice-mini`、`dsh-voice-kit`、`dsh-voice-talk`、`dsh-voice-studio`、`dsh-voice-local`、`@meomeo-dev/dsh-voice-tts`、`dsh-speech-plugin`、`@motong/dsh-voice`、`@hiye/dsh-voice`、`dsh-voice-call`、`dsh-plugin-voice`、`@lamplitisles/dsh-speech`、`@allmodels/dsh-speech` 等）**仅见包名与元数据，未逐个核验 README**，标注为未验证。

### `dsh-say` 的 GPT-SoVITS 实现要点（已逐行读过 `lib/engines/gptsovits.js`）

- 两种模式：`local`（spawn 用户检出的 `api_v2.py`，生成 yaml、等最多 240 秒）与 `server`（直接打已运行的 API，薄客户端）。
- 引擎发现顺序：配置 → `DSH_VOICE_ENGINE_ROOT` → `~/GPT-SoVITS{, -main}`、`~/gpt-sovits` → **每个盘符根目录**匹配 `/^gpt[-_]?sovits/i` → 已运行的 API。
- 存活探测：`GET /control`，**把 HTTPError 也算作"活着"**。
- 合成：`POST {serverUrl}/tts`，读回**裸 WAV 字节**。
- 配置落盘 `~/.dsh/voice/config.json`。

---

## 三、其他框架的 GPT-SoVITS 集成（可借鉴的设计）

| 项目 | 宿主 | 调用方式 | 值得借鉴的点 |
|---|---|---|---|
| [Zhalslar/astrbot_plugin_GPT_SoVITS](https://github.com/Zhalslar/astrbot_plugin_GPT_SoVITS) | AstrBot | `http://127.0.0.1:9880` 官方 `/tts` | **三种触发**：命令 / 按概率自动 TTS / LLM 工具；情绪预设；按参数+SHA256 做磁盘缓存。**97★，AGPL-3.0** |
| [w2902171175/astrbot_plugin_GPT-SoVITS](https://github.com/w2902171175/astrbot_plugin_GPT-SoVITS) | AstrBot | 本地 API | 16★，AGPL-3.0 |
| [Shiroha135/GPT-SoVITS-v2-TTS-Plugin](https://github.com/Shiroha135/GPT-SoVITS-v2-TTS-Plugin) | MaiBot | `aihttp`，404 时**自动回退到 `/tts`** | v1 `api.py` 没有 `/tts`，这个回退很关键；支持 `/vits` 命令 + 关键词触发 |
| [haide-D/SillyTavern-EchoCore](https://github.com/haide-D/SillyTavern-EchoCore) | SillyTavern 扩展 | 自建 Manager API `:3000` 驱动本地 GSV | **朗读体验最完整**：逐条全文朗读、连续读、段落接力（~100 字起读，之后 ~240 字）、分段字幕高亮、合并 WAV 落盘。**257★，MIT** |
| [cnolka/pot-app-tts-plugin-gpt_sovits](https://github.com/cnolka/pot-app-tts-plugin-gpt_sovits) | Pot-App | **需要给 `api_v2.py` 打补丁**加 `/tts_json` 返回 base64 | 反例：上游没有 JSON 音频，改引擎不如改客户端 |
| [zhaomaoniu/nonebot-plugin-gpt-sovits](https://github.com/zhaomaoniu/nonebot-plugin-gpt-sovits) | NoneBot2 | GSV API | MIT，16★，**2024-09 后停更** |
| [ganpare/gpt-sovits-mcp-server](https://github.com/ganpare/gpt-sovits-mcp-server) | MCP | FastAPI-MCP，角色音色预设 | 无许可证 |
| `koishi-plugin-gpt-sovits-v2-api` / `koishi-plugin-open-vits` | Koishi | GSV v2 API 适配 | MIT / AGPL-3.0 |
| 还可能相关：`gpt-sovits-sdk`(npm, MIT)、`@webgal-tools/voice`、`mioku-service-audio`、[second-state/gpt_sovits_plugin](https://github.com/second-state/gpt_sovits_plugin)(Rust) | | | 未逐一核验 |

**未找到可用集成**（只有博客或 open issue）：ChatGPT-on-WeChat、Open WebUI（仅 [issue #11145](https://github.com/open-webui/open-webui/issues/11145)）、LobeChat（仅 `@lobehub/tts`，GSV 只能走 MCP）、Cherry Studio。

---

## 四、GPT-SoVITS API 契约（从 `api_v2.py` 源码核实）

**启动**：`python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`（默认端口 **9880**，`workers=1`）

**端点**：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/tts` | GET + POST | 合成主接口 |
| `/control` | **仅 GET** | `?command=restart\|exit`；**不带参数返回 400** → 可作为存活信号 |
| `/set_gpt_weights` | **仅 GET** | `?weights_path=….ckpt` |
| `/set_sovits_weights` | **仅 GET** | `?weights_path=….pth` |
| `/set_refer_audio` | 仅 GET | 设置常驻参考音 |

> v1 的 `api.py` **没有 `/tts`**（TTS 挂在根路径 `/`）。遇到 404 应回退到 `/`。

**`/tts` 请求体**（必填：`text`、`text_lang`、`ref_audio_path`、`prompt_lang`）：

```
text, text_lang, ref_audio_path, prompt_text(默认""), prompt_lang,
top_k(15), top_p(1), temperature(1), text_split_method("cut5"),
batch_size(1), batch_threshold(0.75), split_bucket(True),
speed_factor(1.0), fragment_interval(0.3), seed(-1),
media_type("wav"), streaming_mode(False), parallel_infer(True),
repetition_penalty(1.35), sample_steps(32), super_sampling(False),
overlap_length(2), min_chunk_length(16)
```

**响应（关键坑）**：

- **上游没有 base64 / JSON 音频**。`media_type` 是封闭集合 `wav | raw | ogg | aac` —— **`mp3` 会被 400 拒绝**（AstrBot README 里写的 mp3 是插件侧转码）。
- `streaming_mode=0/false` → `Response(bytes, media_type="audio/wav")`，**裸字节**，HTTP 200。
- `streaming_mode=1` → 仍是**音频字节**的 StreamingResponse（不是 JSON）；`true` 分块时**首块是合成出来的 WAV 头**，其后是裸 PCM。
- 失败 → **HTTP 400 + JSON** `{"message":"tts failed","Exception":"…"}`。
- JSON 音频只存在于第三方补丁（Pot-App 的 `/tts_json`）。

**语言**：`zh`、`en`、`ja`、`ko`、`yue`、`auto`、`all_zh`、`all_ja`、`all_ko`、`all_yue`（另有中文别名）。`all_*` = 强制单语言；`zh/yue/ja/ko` = 允许语种混合；`auto` = 全自动切分。

**其他注意事项**：

1. 不先 `set_*_weights` 就得靠 `-c` 的 yaml 给出权重路径，否则报错。
2. `ref_audio_path` 是**服务端路径**，必须是引擎进程能读到的文件或 URL。
3. `prompt_lang` 即使 `prompt_text` 为空也必填；**`prompt_text` 留空会触发引擎对参考音做 ASR**（本机实测：首次合成 43 秒 → 缓存后 1.3 秒）。
4. `workers=1` + 全局可变的模型/参考音状态 ⇒ **模型切换必须串行化**。
5. `media_type:"ogg"` 在超大张量下有已知的 libsndfile 栈溢出风险（[#1199](https://github.com/RVC-Boss/GPT-SoVITS/issues/1199)）。
6. 输出采样率随版本变化（v1/v2/v2Pro 32k、v3 24k、v4 48k）；`sample_steps` 的有效取值也随版本不同（v3 支持 4/8/16/32/64/128，v4 支持 4/8/16/32）。
7. **`sample_steps` 32 → 16 是最有效的加速手段**。

---

## 五、对「自己写一个」的启示

1. **别重写 HTTP 客户端**：`dsh-say` 已经有一份可用的（payload、裸字节、`/control` 当存活、双模式、yaml 生成）。缺的是**客户端那一半**。
2. **架构抄 `dsh-gsv-tts`，引擎换成 GPT-SoVITS**：宿主 `TTSService` + `webServer` 路由 + `AudioStore` 落盘 + **同源短链接**（避免音频进模型上下文），客户端手写 bundle 注入 `conversation.chat.assistant-actions` 与 `settings.section`。
3. **音色预设就是 4 个字段**：`{name, refAudioPath, promptText, promptLang}` —— 与 `dsh-gsv-tts` 的编辑器一致。
4. **朗读前压一压**：中文语音实测约 **5 字/秒**，500 字要读 100 秒（比读还慢）。`dsh-say` 的 `tts_report` 用本地句序压缩把 500 字压到 ~120 字。对"读助手回复"这个场景，**这比换引擎更重要**，另外必须跳过代码块/表格。
5. **文本卫生是底线**：剥代码围栏、URL、路径、长哈希，丢掉 thinking —— `dsh-gsv-tts`（自动排除思考）与 `dsh-voice-chat`（可选 LLM 转述）都这么做。
6. **许可证注意**：最成熟的 GSV 聊天集成（AstrBot Zhalslar、两个 MaiBot 插件）都是 **AGPL-3.0**（网络服务传染）。`dsh-say` MIT/NOASSERTION、`dsh-gsv-tts` MIT、EchoCore MIT。
7. **可选替代方案**：在 GPT-SoVITS 前套一个 OpenAI 兼容的 `/v1/audio/speech` 垫片（见 [GPT-SoVITS#2195](https://github.com/RVC-Boss/GPT-SoVITS/issues/2195)），这样任何"自定义 OpenAI 兼容 TTS"插件都能直接用，顺带兼容 Open-WebUI / LobeChat。

---

## 六、明确未能核验的项

- `tts_infer.yaml` 里各版本的 `languages` 名单（抓取失败）。
- `nonebot-plugin-gpt-sovits` 与 `w2902171175/astrbot_plugin_GPT-SoVITS` 的调用细节（只拿到元数据，README 抓取失败）。
- 上文列出的约 15 个二级 DSH 语音包（只有包名与元数据）。
- VCPChat 的具体 GSV 调用路径。
- ChatGPT-on-WeChat / Open WebUI / LobeChat / Cherry Studio 是否存在可用 GSV 集成（只找到博客与一个 open issue）。
- `sovits-ff-plugin`（Foobar2000，搜索结果被截断）。
