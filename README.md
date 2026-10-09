# dsh-gpt-sovits

[![version](https://img.shields.io/badge/version-v0.3.2-blue)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20DSH%20desktop-lightgrey)

**中文** · [English](#english)

给 **DeepSeek Harness**（DSH）Web GUI 接入 **GPT-SoVITS** 语音合成：每条助手回复一键朗读、自动朗读开关、音色预设与设置面板。用你自己本地部署的引擎和音色，**完全离线、不经云端**。

> **代码是 AI 写的，声音是作者训练的。**
> 本项目由 **DeepSeek（`deepseek-flash`）** 在 DSH 会话中逐轮写成 —— 出主意、修 bug、写测试、读宿主源码、量自己的宿主。完整过程见 [它是怎么来的](./docs/README.zh.md#它是怎么来的)。

```sh
dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits
```

**本仓库不附带任何模型权重、参考音频或音频样本**，也不替你启动引擎 —— 这些都由你自己准备。

---

## 核心特性

| 特性 | 说明 |
|---|---|
| **逐条朗读** | 每条定稿回复的操作条上有 🔊 按钮；播放中再点即停，点别的回复直接切换（单信道抢占） |
| **自动朗读（排队）** | 输入栏左侧小喇叭开关。流式回复只读**新增且已到句号**的部分，**一句接一句念完，绝不打断正在念的那句**；同一条回复只读一次（刷新、切会话都不重复） |
| **启动问候** | 每 0.5 秒向空闲引擎请求一次问候语，**识别到引擎开始工作就停止**（状态每 0.1 秒检测）。它既是"插件活了"的信号，也顺带**预热引擎** |
| **流式／总结分流** | 处理过程**一句一请求**（`cut0`，起播最早）；定稿总结**打包成块交给引擎切**（`cut5`，请求数少、快一倍） |
| **新一轮取消上一轮** | 按外壳自己的轮次计数判定，新一轮开始清空待播队列、作废飞行中的合成；**轮次内不打断** |
| **切换会话即停播** | 判据是外壳发给每个槽位的 `sessionId`，**存在模块级变量**里 —— 切换会话会卸载重挂整棵子树，存在组件里的值永远发现不了切换 |
| **把符号念成人话** | `cmd.exe` → 「cmd点exe」、`3-10` → 「3到10」、`3/4` → 「4分之3」、`C:\Users` → 「C:杠Users」、`是/否` → 「是或否」 |
| **单位不会念错** | `120km/h` → 「120千米每小时」、`100MB/s` → 「100兆字节每秒」、`2.4GHz` → 「2点4吉赫兹」。**词表方式**，新增单位只需加一行 |
| **停顿由标点决定** | 关掉引擎自带静音，裁掉每段音频尾部静音，再按标点插入停顿：句号 340ms、逗号 150ms、省略号 460ms、**段落 520ms** |
| **中文分句完整** | `。！？；…` 及其连写都是句末，句末引号归前句；**段落是硬边界**，不会被合并 |
| **音频只在内存** | 不为每句话写 WAV 到硬盘，直接从内存服务，条数与字节双重上限；升级时自动回收旧版遗留文件 |
| **逐句语速与情感** | 语速、`temperature`、`top-k`、`top-p` 随**每一句**发出，改动从下一句生效；音量是播放属性，改了立刻生效 |
| **音色预设** | 名称 + 参考音频 + 参考文本 + 参考语言，可增删、可设默认；成对权重未变时**跳过切换**，免得每次朗读都重载模型 |
| **只读该读的** | 代码块整块略过、URL/路径/哈希/长标识符替换成"链接/路径/编号/长代码"、表格不念分隔线、反引号里的符号念名字 |
| **设置面板** | 设置 → 语音朗读（GPT-SoVITS）。含运行状况、**内嵌引擎控制台**（stdout/stderr + 启动器判定 + 生成记录）、引擎地址、音色、语速、采样步数、音量、试听。保存即生效 |
| **只监听本机** | 所有路由拒绝非 loopback 来源，写接口额外校验同源 |

---

## 快速开始

### 1. 前置条件

1. 一份**已部署好的 GPT-SoVITS**（`api_v2.py` 能跑起来）
2. 至少一对自己训练的 **GPT（`.ckpt`）+ SoVITS（`.pth`）** 权重，以及一段**参考音频**
3. DSH 桌面版或 Web 版

### 2. 启动引擎

插件只负责"说话"，不负责起引擎：

```sh
cd <你的 GPT-SoVITS 目录>
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

首次要等模型加载完（约 12–30 秒）。

> 健康探测打的是 `GET /control`。该接口**不带参数时按设计返回 HTTP 400**，所以插件把 400 视为"活着"，只有连不上才算"未连接"。

### 3. 安装插件

```sh
dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits
```

装完**刷新页面**（客户端半身在启动图里合成，新插件需要一次页面加载才会出现）。

卸载：`dsh plugin --profile desktop remove dsh-gpt-sovits`

### 4. 配置

打开 **设置 → 语音朗读（GPT-SoVITS）**，填**引擎地址**与至少一组**音色预设**。

| 项 | 默认 | 说明 |
|---|---|---|
| 引擎地址 | `http://127.0.0.1:9880` | `api_v2.py` 的监听地址 |
| 音色预设 | 空 | `名称` + `参考音频路径` + `参考音频文本` + `参考语言` |
| 朗读文本语言 | `zh` | `zh/en/ja/ko/yue/auto` |
| 语速 | `1.0` | 对应引擎的 `speed_factor`，0.5–2.0 |
| 采样步数 | `32` | **嫌慢就降到 16**，这是最有效的加速手段 |
| 音量 / 播放倍速 | 90% / 1× | 浏览器侧，仅影响本机播放 |

**参考音频怎么选**：3–10 秒、干净人声、无背景音乐；路径必须是**引擎所在机器能读到的路径**。**`参考音频文本` 强烈建议填写** —— 留空会让引擎先对参考音频做一次识别，首次合成从 ~1.5 秒变成 ~40 秒。

设置落盘在 `$DSH_HOME/gpt-sovits/`。

### 5. 验证安装

```sh
node scripts/selfcheck.mjs      # 离线自检，61 项
node scripts/integration.mjs    # 真实引擎集成测试，16 项（需引擎已启动）
```

---

## 版本与下载

**任何版本都可以随时下载或安装**，不必迁就最新版。每个发行版都有 tag 锚定，**旧版本不会被后续更新覆盖**。

| 你想要 | 怎么做 |
|---|---|
| 最新版 | 仓库首页 → **Code** → Download ZIP |
| **某个发行版** | **[Releases](https://github.com/91koukou/dsh-gpt-sovits/releases) 页** → 选版本 → `Source code (zip)` |
| 任意历史提交 | `git clone` 后 `git checkout <提交哈希>` |
| 安装指定版本 | `dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits#v0.3.0` |

| 版本 | 说明 |
|---|---|
| `v0.1.0` | 首个发布版：逐条朗读按钮、自动朗读开关、音色预设、设置面板 |
| `v0.2.0` | 引擎生命周期跟随 DSH、文本规范化、流式/总结分流、队列式朗读、启动问候、引擎控制台 |
| `v0.3.0` | 中文分句补全、按标点插入停顿并裁掉引擎尾部静音、切换工作区取消朗读、音频改内存、逐句语速与情感 |
| `v0.3.1` | **切换会话真正停播**：判据改为跨卸载重挂存活的模块级变量 |
| `v0.3.2` | **四处可靠性修复**：计划内的取消不再被上报成播放失败、被淘汰的音频自动重新合成、一个回合只重置一次、诊断事件有了内存与磁盘上限 |

版本变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| **[完整文档（中文）](./docs/README.zh.md)** | 前置条件、设计取舍、**附录：每项功能的实现方式**（文件/函数/参数/数据结构）、实测环境与性能、19 个"踩过的坑" |
| **[Full documentation (English)](./docs/README.en.md)** | 同上，英文 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本的变更明细 |
| [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) | **第三方代码复用的完整清单**（具体文件、具体语句、我做了哪些改动） |
| [RESEARCH-similar-plugins.md](./RESEARCH-similar-plugins.md) | 同类插件调研：为什么是"自己写"而不是装现成的 |

---

## 许可

本项目代码以 **MIT** 许可发布，详见 [LICENSE](./LICENSE)。第三方代码复用的完整清单见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

- 本项目是**第三方社区插件**，与 DeepSeek、GPT-SoVITS（RVC-Boss）及其各自的维护者**无任何隶属、合作或背书关系**。
- 本插件**不分发、不托管任何模型权重、参考音频或合成音频**，也不包含任何语音克隆服务 —— 它只是把你**自己**的本地引擎接到 DSH 界面上。
- **仅可使用你有权使用的声音**：未经授权，不得克隆、模仿或合成公众人物、名人或他人的声音。参考音频与训练权重的权利与合规责任完全由使用者承担。
- **合成音频可能被误认为真人发声**：对外分发时建议主动披露其为 AI 合成内容。
- 你的模型、参考音频与生成音频**不在**本项目的 MIT 许可覆盖范围内。

---

## English

**TTS for the DeepSeek Harness Web GUI, powered by your own local GPT-SoVITS.** A read-aloud button on
every assistant reply, an auto-read toggle, voice presets and a settings panel — fully offline, nothing
goes through a cloud service.

```sh
dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits
```

**This repository ships no model weights, reference audio or audio samples**, and it will not start the
engine for you — you provide all of that.

Core features: per-reply read-aloud button · queued auto-read that never interrupts the sentence being
spoken · a startup greeting that doubles as engine warm-up · separate strategies for streaming steps and
settled summaries · a new turn cancels the previous one · a conversation switch stops playback · symbols,
units and punctuation spoken the way a person would say them · audio kept in memory · per-sentence speed
and expression · voice presets · an embedded engine console · loopback-only routes.

**Full documentation: [docs/README.en.md](./docs/README.en.md)** · **Downloads**: see the
[Releases](https://github.com/91koukou/dsh-gpt-sovits/releases) page.
