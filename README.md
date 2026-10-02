# dsh-gpt-sovits

**中文** · [English](./README.en.md)

> ### 🐋 这只鲸鱼娘，自己给自己装了一副嗓子
>
> 本项目由 **DeepSeek（`deepseek-flash`）** 在 DSH 会话中逐轮写成 —— 出主意、修 bug、写测试、读宿主源码、量自己的宿主，都是它做的。
>
> **代码是 AI 写的，声音是作者训练的。**
>
> **验证状态：全部通过** ✅ —— 42 项离线自检 ✅ / 12 项真实引擎集成测试 ✅ / 界面按钮与自动朗读人工实测 ✅
>
> 开发与验证环境：**Windows 11** · DSH 桌面版（客户端契约 `0.2.0-rc.2`）· Node **v24.21.0** · **RTX 5070 Ti (16 GB)** · Python **3.9.13** + torch **2.7.0+cu128** · GPT-SoVITS **v2Pro** @ `127.0.0.1:9880`
>
> 详细说明见 [它是怎么来的](#它是怎么来的) 与 [✅ 测试通过的运行环境](#-测试通过的运行环境)。

给 DeepSeek Harness（DSH）Web GUI 接入 **GPT-SoVITS** 语音合成：每条助手回复一键朗读、自动朗读开关、音色预设与设置面板。用你自己本地部署的 GPT-SoVITS 引擎和音色，完全离线、不经云端。

```sh
dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits
```

**本仓库不附带任何模型权重、参考音频或音频样本**，也不替你启动引擎 —— 这些都由你自己准备。

---

## 前置条件

1. 一份**已部署好的 GPT-SoVITS**（`api_v2.py` 能跑起来）
2. 至少一对自己训练的 **GPT（`.ckpt`）+ SoVITS（`.pth`）** 权重，以及一段**参考音频**
3. DSH 桌面版或 Web 版

引擎自己启动：

```sh
cd <你的 GPT-SoVITS 目录>
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

---

## 为什么是"自己写"而不是装现成的

同类插件确实存在，但都不满足"接 GPT-SoVITS 且带界面按钮"这个组合：

| 插件 | 引擎 | 逐条朗读按钮 | 自动朗读 | 设置面板 |
|---|---|---|---|---|
| [`dsh-say`](https://github.com/fangqian616/dsh-say) | **GPT-SoVITS** ✅ | ❌ 只有 agent 工具 `tts_*` | ❌ | ❌ |
| [`dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv) | GSV-TTS-Lite（GPT-SoVITS 的**分支**，非上游） | ✅ | ✅ | ✅ |
| [`dsh-fish-tts`](https://github.com/MaRi23333/dsh-fish-tts) | Fish Audio 云端 | ✅ | ✅ | ✅ |
| [`dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat) | Edge TTS / MiMo / 自定义 OpenAI 兼容 | ✅ | ✅ | ✅ |
| **本插件** | **GPT-SoVITS** ✅ | ✅ | ✅ | ✅ |

`dsh-gpt-sovits` 与 `dsh-sovits` 这两个包名在 npm 上均为 404 —— 上游 GPT-SoVITS + 完整 GUI 的位置是空的。

---

## 功能

- **逐条朗读**：每条定稿助手回复的操作条上有一个 🔊 按钮；播放中再点即停，点别的回复直接切换（单信道抢占）。
- **自动朗读**：输入栏左侧的小喇叭开关。开启后自动朗读新回复；**同一条回复只读一次**（`localStorage` 记录，刷新页面、切换会话都不重复）。
- **长回复分段**：按句子切成 ≤110 字的小段，**边合成边播放**（第 N+1 段在本段播放时预取），所以长回复不必等全文合成完才出声。
- **文本清洗**：代码块整块略过、URL/路径/哈希/长标识符替换成"链接/路径/编号/长代码"，Markdown 标记与 HTML 标签剥掉 —— 只读该读的。
- **音色预设**：名称 + 参考音频路径 + 参考文本 + 参考语言，可增删；可设默认音色。
- **设置面板**：设置 → 语音朗读（GPT-SoVITS）。引擎地址、音色、语言、语速、采样步数、音量、播放倍速、试听、引擎健康检查；保存即生效。
- **同源短链接**：合成音频落盘后以同源 URL 提供，**不把音频塞进模型上下文**。
- **只监听本机**：所有路由拒绝非 loopback 来源，写接口额外校验同源，即使宿主监听 0.0.0.0 也不对外开放。

---

## 安装

```sh
dsh plugin --profile desktop add file:C:/绝对路径/dsh-gpt-sovits
```

装完**刷新页面**（客户端半身在启动图里合成，新插件需要一次页面加载才会出现）。卸载：

```sh
dsh plugin --profile desktop remove dsh-gpt-sovits
```

---

## 前置：启动 GPT-SoVITS API

插件只负责"说话"，不负责起引擎。引擎侧用官方 `api_v2.py`：

```sh
cd <你的 GPT-SoVITS 目录>
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

`-c` 指向的 yaml 里 `custom:` 段的 `t2s_weights_path` / `vits_weights_path` 决定默认音色权重。启动要等模型加载完（首次约 20–60 秒），设置页的"引擎"一行会显示 `运行中`。

> 健康探测打的是 `GET /control`。这个接口**不带参数时按设计返回 HTTP 400**，所以插件把 400 视为"活着"，只有连不上才算"未连接"。

---

## 配置

打开 **设置 → 语音朗读（GPT-SoVITS）**。

| 项 | 默认 | 说明 |
|---|---|---|
| 引擎地址 | `http://127.0.0.1:9880` | `api_v2.py` 的监听地址 |
| 检出目录 | 自动发现 | GPT-SoVITS 安装目录，用来列出你训练好的权重。**填了就跳过盘符扫描**（见 [已知限制](#已知限制)） |
| 音色预设 | 空 | `名称` + `参考音频路径` + `参考音频文本` + `参考语言` |
| 默认音色 | 第一个 | 朗读时用的音色；留空 = 用列表第一个 |
| 朗读文本语言 | `zh` | `zh/en/ja/ko/yue/auto` |
| 语速 | `1.0` | 对应引擎的 `speed_factor`，0.5–2.0 |
| 采样步数 | `32` | **嫌慢就降到 16**，这是最有效的加速手段 |
| 音量 / 播放倍速 | 90% / 1× | 浏览器侧，仅影响本机播放 |
| 自动朗读新回复 | 关 | 等同输入栏那个小喇叭开关 |

落盘位置：`$DSH_HOME/gpt-sovits/`（`settings.json` + `audio/`）。也可以在 profile 的 `cordis.patch.yml` 里给 `gpt-sovits` 行加 `config` 固定默认值 —— 但**设置页保存的值优先**。

### 参考音频怎么选

- 3–10 秒、干净人声、无背景音乐，效果最好。
- 路径必须是**引擎所在机器能读到的路径**（`ref_audio_path` 是服务端路径，不是浏览器上传）。
- **`参考音频文本` 强烈建议填写**：留空会让引擎先对参考音频做一次识别，首次合成会从 ~1.5 秒变成 ~40 秒（结果会被缓存，之后恢复）。

---

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/gpt-sovits/api?action=settings` | 读有效设置 |
| `POST` | `/gpt-sovits/api?action=settings` | 写设置补丁 |
| `POST` | `/gpt-sovits/api?action=synthesize` | 合成一段文本，返回 `{url, bytes, voice, cached}` |
| `GET` | `/gpt-sovits/api?action=health` | 探测引擎 |
| `GET` | `/gpt-sovits/audio/<id>.wav` | 播放合成结果（`id` 是内容摘要，可长期缓存） |

`/tts` 请求体遵循 `api_v2.py` 的契约：`media_type: "wav"`、`streaming_mode: false`、`text_split_method: "cut5"`、`sample_steps`、`repetition_penalty: 1.35` 等；引擎**直接返回 WAV 字节**（上游没有 JSON/base64 音频，`media_type` 是 `wav|raw|ogg|aac` 的封闭集合，`mp3` 会被 400 拒绝）。

---

## 开发与自检

```sh
# 离线自检：语法、模块加载契约、slot 名、文本清洗与分块、store 读取、状态目录（42 项）
node scripts/selfcheck.mjs

# 真实集成测试：起本地 HTTP 载体，用真引擎跑一遍全链路（12 项）
# 默认优先测工作区源码；--source installed 则测「运行中的 DSH 实际加载的那一份」
node scripts/integration.mjs --ref <你的参考音频.wav>
node scripts/integration.mjs --skip-synthesis          # 不触网，只测路由与校验
node scripts/integration.mjs --ref ref.wav --gpt GPT_weights/your.ckpt --sovits SoVITS_weights/your.pth
```

> `--ref` 是合成类检查的**必需**参数：本仓库不附带任何参考音频，请指向你自己的。

`--experimental-vm-modules` 下自检还会额外做一次 ESM 解析（默认跳过该项）。

> ⚠️ `integration.mjs` 会把 `speed` / `sampleSteps` 写进**真实的** `settings.json`（它测的就是真插件）。跑完请到设置页确认这两项是你想要的值。

### 界面是怎么接进去的

两个按钮都放进 DSH 自己的槽位，并套用 DSH 自己的按钮规范，而不是自画一套：

| 元素 | 槽位 | 位置 / 实现 |
|---|---|---|
| 🔊 朗读按钮 | `conversation.chat.assistant-actions` | 每条助手回复的操作条（与复制/分支/反馈同一行），`order: 20`；几何按官方 `MessageFeedbackActions` 的 28px 盒 / 6px padding / 15px 字形，播放中改用外壳自带的 **Pause** 图标 |
| 🔊 自动朗读开关 | `conversation.input.left` | 输入框工具栏行，`order: 30`；与官方 `VoiceInput` 的 28px 触发器同规格 |
| 设置页 | `settings.section` | 齿轮 → 语音朗读（GPT-SoVITS），`order: 60` |

**开关为什么不在"左边"** —— 这是外壳的布局决定的。输入框那一行：

```css
.row { flex-wrap:wrap; justify-content:space-between; gap:12px; padding:2px 8px 6px; }
```

三个 flex 子项：① 权限 + 计划组（`input.permission` + `input.plan`）② **`input.left`（本插件）** ③ `trailing`（模型选择 + 发送）。`space-between` 把三者**均摊整行**，所以小喇叭落在①与③**之间偏右** —— 视觉上就是"权限控制的右边"。

要挪位置只能换槽位：`input.left` 已经是第②个位置，再靠左做不到；改用 `input.right` 会并入③那一组，或调 `order` 调整组内顺序。

**图标说明**：DSH 自带 377 个图标，**没有任何喇叭/音量/声音图标**（只有 Play/Pause），所以喇叭是本地绘制的 —— 但严格遵循外壳的图标契约（`size=16`、`viewBox="0 0 16 16"`、`fill="none"`、1px `currentColor` 描边），因此看起来属于同一套。悬停与激活态由注入的 CSS（`:hover` / `[data-active]`）提供，而不是内联样式 —— 内联样式表达不了这两者。

### 引擎自启动（重要）

**DSH 重启会带走引擎进程** —— 实测两次重启、两次消失，表现就是"突然没声音了"。插件只负责说话，不负责起引擎，所以引擎必须独立于 DSH 存活。

已装好的三层自启动：

| 层 | 路径 | 作用 |
|---|---|---|
| 启动器 | `$DSH_HOME/gpt-sovits/start-engine.bat` | 幂等：端口已监听就跳过，否则拉起 `api_v2.py` 并等待就绪 |
| 无窗口包装 | `$DSH_HOME/gpt-sovits/run-hidden.vbs` | 隐藏窗口运行，避免开机闪黑框 |
| 登录自启 | 启动文件夹 `GPT-SoVITS 语音引擎.lnk` | 登录后自动执行上面两层 |

- **配置自动跟随**：启动器从 `settings.json` 读端口（`serverUrl`）与可选的 `engineRoot`，所以在设置页改引擎地址，自启动也跟着变。
- **诊断日志**：`$DSH_HOME/gpt-sovits/engine-start.log`（每次判定与耗时，正常应出现 `ready after N checks`）。
- **不想要自启动**：删掉启动文件夹里那个快捷方式即可。
- 计划任务（`schtasks`）需要管理员权限，实测 `Access is denied`，所以走了启动文件夹这条路。

> **两个 cmd 的坑**（都实际踩过，别再踩）：
> 1. **批处理里不能有中文。** `cmd.exe` 按控制台代码页解析 `.bat`，非 ASCII 注释会被当命令执行（实测报 `'独立于' is not recognized as an internal or external command`）。`start-engine.bat` 因此全 ASCII，中文说明只在本文件里。
> 2. **别用 `timeout` 做延时。** 输入被重定向时 `timeout.exe` 直接报 `Input redirection is not supported` 并立刻退出，导致就绪轮询 2 秒内跑完 60 次、把成功启动误判成 TIMEOUT。改用 `ping -n N 127.0.0.1 >nul`。

### 自动朗读是"下一条起"生效

点开输入栏那个小喇叭（或设置页的「自动朗读新回复」）之后，**已经显示在屏幕上的那条回复不会被朗读** —— 开关是关于"新回复"的，不是"把当前这条念一遍"。

想验证它真的在工作：**开着开关再发一条消息**，新回复一到就会自己出声。

### 只有真机才会暴露的坑（已修）

这些都不是推测，是诊断日志量出来的运行时事实。列在这里是因为**每一条都对应一个"看起来完全正常、就是不响"的症状**：

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | `turnTail` 是 list 槽位，**每轮渲染一次**，N 个驱动器抢一个单信道播放器 | 时响时不响 | 改为**模块级共享占位集合**：谁先看到谁朗读 |
| 2 | 用**每实例**的 `armed` 标志判断"刚被打开" | N 份状态互不可见 → **全都只记录、没人朗读** | 闸门改用**持久化的"上次已读"标记**（全局共享） |
| 3 | 组件在**调用 hook 之前 `return`**（`if (typeof turn !== "number") return null` 在 `useChat(...)` 之前） | 违反 Hooks 规则 → React 抛错 → **错误边界静默卸载** → 按钮和驱动器**在界面上根本不存在** | 所有 hook 无条件提前调用；并加**静态断言**禁止"hook 前早返回" |
| 4 | `turnTail` 的 `turn` prop **实测是 `object` 而非 number** | 类型判断永远成立 → 驱动器永不工作 | **彻底不依赖该 prop**，改用占位集合协调 |
| 5 | 诊断探针**无节流**，每次渲染发一次 HTTP | 一次页面加载刷出**几千条**日志与同步写盘 | 按事件名去重 + 每副本只报一次 |
| 6 | 引擎绑在 DSH 生命周期上 | **每次重启 DSH 就静音** | 三层自启动（见上） |

回归测试兜底：假 store + 假 React effect + 假 Audio，验证"3 个驱动器挂载、**恰好 1 个**发声"、"开关关闭时静默"、"已存在的回复不重读"。

### 状态目录与生效方式

| 事项 | 说明 |
|---|---|
| 设置/音频默认位置 | `$DSH_HOME/gpt-sovits`；宿主进程若读不到 `DSH_HOME`，回退到 `~/.dsh/gpt-sovits` |
| 宿主半身改动 | `dsh-gpt-sovits` 是 `file:` 依赖，pnpm 会**复制**而非链接，所以改工作区源码不影响已装副本；改完要重新同步：直接覆盖 `~/.dsh/profiles/desktop/node_modules/dsh-gpt-sovits/`，或先 `remove` 再 `add` |
| 客户端半身何时出现 | 客户端 bundle 在启动图里合成，**需要刷新页面** |
| 宿主半身何时重载 | 安装时插件会即时挂载（路由立刻可用）；但已加载的模块代码**不会热重载**，代码改动需重启 DSH |

### 已知限制

- **Windows 下会枚举盘符以自动发现引擎**（`lib/index.js` 的 `engineRootCandidates()`）。如果你没有在设置里填「检出目录」也没有设 `DSH_SOVITS_ENGINE_ROOT`，插件会**从 `A:\` 到 `Z:\` 逐个尝试读取盘符根目录**，挑出名字匹配 `/^gpt[-_]?sovits/i` 的目录作为候选。

  它的实际行为比听起来克制：

  | 项 | 实际行为 |
  |---|---|
  | 读什么 | **只读盘符根目录这一层**（`readdirSync`），不递归、不遍历子目录树 |
  | 拿什么 | 只拿**目录名**，用于匹配；不读取文件内容 |
  | 不存在的盘 | `A:\`、`B:\` 之类的空软驱会在 `try/catch` 里被跳过（有些机器的 A: 是软驱，读它会弹「请插入磁盘」） |
  | 何时执行 | 只在访问「模型列表」和打开设置页时；`listWeights()` 命中第一个合法检出即停止 |
  | 写盘吗 | **完全不写**。这条路径上没有任何写入操作 |

  **想让它彻底不扫**：在设置页「检出目录」里填上你的 GPT-SoVITS 路径（或设环境变量 `DSH_SOVITS_ENGINE_ROOT`）。显式配置排在候选列表最前，命中后盘符扫描不会执行。

  之所以这么设计：官方 Windows 包是个压缩档，人们解压到哪儿都有（常见是副盘根目录），没有固定安装位置；而且路径必须是**引擎进程**能读到的，让用户手输容易出错。

- 合成缓存是进程内 `Map` + 落盘 WAV，上限 120 条；重启清空索引（WAV 仍在 `audio/`）。
- 播放倍速依赖浏览器的 `preservesPitch`；不支持时锁定 1×（设置页会说明）。
- `prompt_text` 留空时首次合成很慢（引擎要先做 ASR），之后走缓存恢复正常。

---

## 它是怎么来的

**这只鲸鱼娘自己给自己装了一副嗓子。**

这个插件的每一行代码，都是在 DSH 里由 **DeepSeek（`deepseek-flash`，DeepSeek 官方 provider）** 与作者对话逐轮写出来的 —— 包括读外壳源码确定槽位契约、量出 store 的真实结构、定位那串"看起来完全正常就是不响"的 bug，以及顶着一次次失败把 i18n、自检和集成测试补齐。

作者做的事是：提需求、配好引擎和音色、在真机上点按钮、把报错截图发回来。**声音是作者训练的，嗓子是它自己装的。**

值得注意的是，它一开始**并不了解自己的宿主**：第一次尝试把 `snapshot.legacy.nodes` 当成节点容器（那是另一个 DSH 版本、另一个插件留下的写法），连错四轮；最后是靠一个写进宿主的**诊断探针**把容器的真实成员列表打出来才修对。README 里那张"坑"表，就是这么攒出来的。

---

## ✅ 测试通过的运行环境

> **下表是这份代码真实跑通、并且测试全部通过的环境** —— 不是"推荐配置"，也不是从文档抄来的。
>
> 下列每一项都由本机实测采集；配套的 **42 项离线自检**与 **12 项真实引擎集成测试**都在这一组合下通过，界面按钮与自动朗读也在这台机器上由作者实际点击验证。
>
> 换到别的 OS、别的 DSH 版本或别的显卡，**理论上可用但未经测试** —— 若遇到问题欢迎开 issue 附上你的环境信息。

| 项目 | 测试通过的实际值 |
|---|---|
| 操作系统 | **Windows 11 专业版** `10.0.26200`（64 位） |
| 宿主 | **DSH 桌面版**（Electron），profile = `desktop` |
| 宿主客户端契约 | `@deepseek-ai/dsh-client-*` **0.2.0-rc.2** |
| Node.js（插件运行时） | **v24.21.0**（DSH 自带运行时；`engines` 要求 `>=22`） |
| GPU | **NVIDIA GeForce RTX 5070 Ti**，16303 MiB 显存，驱动 616.92 |
| Python（引擎侧） | **3.9.13**（GPT-SoVITS 集成运行时） |
| PyTorch / CUDA | **2.7.0+cu128** / **CUDA 12.8** |
| GPT-SoVITS 检出 | `GPT-SoVITS-v2pro-20250604-nvidia50`（含 `GPT_weights` … `v4`、`SoVITS_weights` … `v4` 全部权重目录） |
| 实测使用的模型版本 | **v2Pro** |
| 引擎监听 | `http://127.0.0.1:9880` |
| 插件版本 | v0.1.0 |

**实测性能**（同一台机器，`sample_steps 32`、参考文本已填）：

| 场景 | 耗时 |
|---|---|
| 引擎冷启动（加载权重） | 约 **12–30 秒** |
| 首次合成（参考音未识别过） | 约 **20 秒** |
| 之后的新句子 | **1.0–1.6 秒** |
| 重复的句子（缓存命中） | **0 秒** |

> 引擎侧显存占用实测约 **2.7 GB**（v2Pro 权重 + BERT + CNHuBERT）。

---

## 引用与致谢

本项目的代码以 MIT 发布，其中**有一处是实质性复用他人实现**，其余为接口契约与布局常量的借鉴。**完整清单（含具体文件、具体语句、以及我做了哪些改动）见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)** —— 这里只给摘要：

| 来源 | 许可证 | 复用了什么 |
|---|---|---|
| [`MaRi23333/dsh-fish-tts`](https://github.com/MaRi23333/dsh-fish-tts) | MIT | **`cleanForSpeech` 的文本清洗正则链 —— 十来个正则逐字符相同**（`lib/client.js` 的 `cleanForTts`），以及 `window.__ModuleLoader__.load` 的 bundle 形态 |
| [`fangqian616/dsh-say`](https://github.com/fangqian616/dsh-say) | MIT | **GPT-SoVITS `/tts` 请求体与默认值**、`GET /control`（HTTP 错误视为存活）的探活方式（`lib/engines/gptsovits.js`） |
| DSH 内置 `@deepseek-ai/dsh-client-*` | MIT | 插件注册模式（`ctx.slots.inject` / `register` / `settings.section`）、注入样式表的做法、**操作条按钮与图标契约的几何常量**（28px 盒 / 6px padding / 15px 字形 / `size=16` / 1px `currentColor`）、以及"读 `snapshot.nodes.values()`"这一句 |
| [`MeteorNOX/DeepSeek-Balance-Whale-Widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | MIT | `DSH_HOME \|\| ~/.dsh` 的两级状态目录回退 |
| [`RVC-Boss/GPT-SoVITS`](https://github.com/RVC-Boss/GPT-SoVITS) | MIT | `api_v2.py` 的端点契约（没有代码被复制） |

下面这几个项目**只作为参考阅读，没有复用代码**，但值得致谢：
[`TaoruiLiu19/dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv)（证明了宿主/客户端分半这条路可行）、
[`maoyuching/dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat)、
[`haide-D/SillyTavern-EchoCore`](https://github.com/haide-D/SillyTavern-EchoCore)。

**唯一运行时依赖**：`@deepseek-ai/schemastery`（MIT，© DeepSeek），从 registry 安装、未内联。

---

## 许可与第三方声明

- 本项目是**第三方社区插件**，与 DeepSeek、GPT-SoVITS（RVC-Boss）及其各自的维护者**无任何隶属、合作或背书关系**。"DeepSeek"、"DeepSeek Harness" 与 "GPT-SoVITS" 等名称归其权利人所有，此处仅为描述性使用。
- 本插件**不分发、不托管任何模型权重、参考音频或合成音频**，也不包含任何语音克隆服务。它只是把你**自己**的本地引擎接到 DSH 界面上。
- **仅可使用你有权使用的声音**：未经授权，不得克隆、模仿或合成公众人物、名人或他人的声音。参考音频与训练权重的权利与合规责任完全由使用者承担。
- **合成音频可能被误认为真人发声**：对外分发时建议主动披露其为 AI 合成内容。
- 本项目代码以 **MIT** 许可发布；你的模型、参考音频与生成音频**不在**该许可覆盖范围内。
