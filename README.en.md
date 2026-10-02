# dsh-gpt-sovits

**English** · [中文](./README.md)

> ### 🐋 This whale girl installed a voice for herself
>
> Every line here was written in a DSH session by **DeepSeek (`deepseek-flash`)** — thinking up the approach, fixing the bugs, writing the tests, reading the host's source, and measuring its own host.
>
> **The code is AI-written. The voice is trained by the author.**
>
> **Verification: all green** ✅ — 56 offline checks ✅ / 16 live-engine integration checks ✅ / button and auto-read confirmed by hand ✅
>
> Verified on: **Windows 11** · DSH desktop build (client contract `0.2.0-rc.2`) · Node **v24.21.0** · **RTX 5070 Ti (16 GB)** · Python **3.9.13** + torch **2.7.0+cu128** · GPT-SoVITS **v2Pro** @ `127.0.0.1:9880`
>
> More detail in [How it came about](#how-it-came-about) and [✅ The environment the tests passed on](#-the-environment-the-tests-passed-on).

**GPT-SoVITS** text-to-speech for the DeepSeek Harness (DSH) web GUI: per-reply read-aloud, an auto-read toggle, voice presets and a settings page. It drives *your own* locally deployed GPT-SoVITS engine and voices — fully offline, nothing goes to a cloud.

```sh
dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits
```

**This repository ships no model weights, no reference audio and no audio samples**, and it does not start your engine. Bring your own.

---

## Requirements

1. A **working GPT-SoVITS install** (`api_v2.py` starts and serves)
2. At least one pair of **GPT (`.ckpt`) + SoVITS (`.pth`)** weights you trained, plus a **reference clip**
3. DSH desktop or web build

Start the engine yourself:

```sh
cd <your GPT-SoVITS directory>
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

---

## Why this exists instead of installing one

Similar plugins do exist, but none of them covers "drives GPT-SoVITS *and* has GUI buttons":

| Plugin | Engine | Per-reply button | Auto-read | Settings page |
|---|---|---|---|---|
| [`dsh-say`](https://github.com/fangqian616/dsh-say) | **GPT-SoVITS** ✅ | ❌ agent tools only (`tts_*`) | ❌ | ❌ |
| [`dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv) | GSV-TTS-Lite (a **fork** of GPT-SoVITS, not upstream) | ✅ | ✅ | ✅ |
| [`dsh-fish-tts`](https://github.com/MaRi23333/dsh-fish-tts) | Fish Audio (cloud) | ✅ | ✅ | ✅ |
| [`dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat) | Edge TTS / MiMo / custom OpenAI-compatible | ✅ | ✅ | ✅ |
| **this plugin** | **GPT-SoVITS** ✅ | ✅ | ✅ | ✅ |

The npm names `dsh-gpt-sovits` and `dsh-sovits` both returned 404 — the "upstream GPT-SoVITS + full GUI" slot was empty.

---

## Features

- **Per-reply read-aloud**: a 🔊 button in every settled assistant reply's action row. Click again to stop, click another reply to switch (single-channel, barge-in).
- **Auto-read (queued, never preempting)**: the speaker toggle in the composer. New replies are read automatically, and **each reply is read exactly once** (`localStorage` mark — a page refresh or a session switch will not repeat it). A reply **streams in**, so only the **new, sentence-complete** part is queued, and **sentences are spoken one after another without ever cutting off the one playing**.
- **Startup greeting**: implemented as specified — **every 0.5 s** the plugin asks the idle engine for a greeting and **stops the moment the engine starts working** (engine state sampled **every 0.1 s**). It is both the "plugin is alive" signal and the **engine warm-up**. Text editable and switchable.
- **Streaming and the summary use different strategies**: streaming steps go **one sentence per request** (`cut0`, earliest possible audio, no truncation); a settled summary is **packed into blocks and split by the engine** (`cut5`, far fewer requests, twice as fast).
- **A new turn cancels the previous one**: keyed on the shell's own turn counter (`timeline.turnOrder`); a new turn `stop()`s playback, clears the queue and discards in-flight synthesis. **Nothing is interrupted within a turn.**
- **No gaps between sentences**: while sentence N plays, N+1 and N+2 are already synthesizing (prefetch window 2); short sentences are merged when a reply settles instead of each costing a request.
- **Symbols become speech**: `cmd.exe` → `cmd点exe`, `3-10` → `3到10`, `v2.7.0` → `v2点7点0`, `36.5` → `36点5`, `127.0.0.1` → `127点0点0点1`, `是/否` → `是或否`, `3/4` → `4分之3`, `C:\Users` → `C:杠Users`. Dates such as `2024-10-03` are preserved rather than read as a range.
- **Text hygiene**: code fences are skipped whole, URLs/paths/hashes/long identifiers collapse to "link/path/id/code", Markdown markers and HTML tags are stripped — only what should be spoken is spoken.
- **Voice presets**: name + GPT weights + SoVITS weights + reference clip + reference transcript; add and remove freely, pick a default. Weights are switched on demand (`set_gpt_weights` / `set_sovits_weights`) and **skipped when the pair is unchanged**, so a read does not reload the model every time.
- **Settings page**: Settings → Voice (GPT-SoVITS). It opens with **live status** (engine, whether it is generating, greeting state, active voice and whether its reference clip exists, loaded weights) and the **engine console**; below that are engine URL, checkout directory, voices, language, speed, sampling steps, volume, playback rate and preview. Saving takes effect immediately.
- **Engine console**: the engine's stdout/stderr (TTS config, weight loading, the target text of every synthesis, access lines, tracebacks) plus the launcher's decisions and the transcript of what was generated, **embedded in the settings page** with 1.5 s / 0.5 s / manual refresh. Chinese renders correctly as UTF-8.
- **Same-origin short links**: synthesized audio is written to disk and served over a same-origin URL, so **audio bytes never enter the model's context**.
- **Loopback only**: every route refuses non-loopback peers, write routes additionally check the origin, so nothing is exposed even when the host listens on 0.0.0.0.

---

## Install

```sh
dsh plugin --profile desktop add file:C:/absolute/path/dsh-gpt-sovits
```

Then **refresh the page** (the client half is composed into the boot graph, so a new plugin needs one page load to appear). To remove it:

```sh
dsh plugin --profile desktop remove dsh-gpt-sovits
```

### Versions and downloads

**Every version stays downloadable and installable** — you never have to take the latest.

| You want | How |
|---|---|
| The latest | Repository home → **Code** → Download ZIP |
| **A specific release** | The **[Releases](https://github.com/91koukou/dsh-gpt-sovits/releases)** page → pick a version → `Source code (zip)` |
| Any historical commit | `git clone`, then `git checkout <commit>` |
| Install a specific version | `dsh plugin --profile desktop add github:91koukou/dsh-gpt-sovits#v0.1.0` |

Each release is anchored by a tag, so **an older version is never overwritten by a later update**:

| Version | Note |
|---|---|
| [`v0.1.0`](https://github.com/91koukou/dsh-gpt-sovits/releases/tag/v0.1.0) | First release: per-reply read-aloud button, auto-read toggle, voice presets, settings page |
| `v0.2.0` | Engine lifecycle follows DSH, symbol normalisation, streaming/summary split, queued reading, startup greeting, engine console |

Per-version changes are listed in [CHANGELOG.md](./CHANGELOG.md).

---

## Prerequisite: start the GPT-SoVITS API

The plugin only *speaks*; it does not start the engine. Use the official `api_v2.py`:

```sh
cd <your GPT-SoVITS directory>
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

The `custom:` block of the yaml passed to `-c` decides the default weights (`t2s_weights_path` / `vits_weights_path`). Startup waits for the models to load (roughly 20–60 s the first time); the settings page's engine row shows `running` once it answers.

> The health probe hits `GET /control`, which **by design answers HTTP 400 when called without a `command`**. The plugin therefore treats 400 as "alive" and only a transport failure as "unreachable".

---

## Configuration

Open **Settings → Voice (GPT-SoVITS)**.

| Field | Default | Notes |
|---|---|---|
| Engine URL | `http://127.0.0.1:9880` | Where `api_v2.py` listens |
| Checkout directory | auto | GPT-SoVITS install directory, used to list the weights you trained. **Setting it skips the drive scan** (see [Known limitations](#known-limitations)) |
| Voice presets | empty | `name` + `GPT weights` + `SoVITS weights` + `reference clip` + `reference transcript` + `reference language` |
| Default voice | first | Which preset to speak with; empty means the first in the list |
| Text language | `zh` | `zh/en/ja/ko/yue/auto` |
| Speed | `1.0` | Maps to the engine's `speed_factor`, 0.5–2.0 |
| Sampling steps | `32` | **Drop to 16 if it feels slow** — the single most effective speedup |
| Volume / playback rate | 90% / 1× | Browser-side, affects local playback only |
| Auto-read new replies | off | Same switch as the composer's speaker toggle |

State lives in `$DSH_HOME/gpt-sovits/` (`settings.json` + `audio/`). You can also pin defaults with a `config` block on the `gpt-sovits` row in the profile's `cordis.patch.yml` — but **values saved from the settings page win**.

### Choosing a reference clip

- 3–10 seconds, clean single voice, no background music.
- The path must be **readable by the machine running the engine** (`ref_audio_path` is a server-side path, not a browser upload).
- **Fill in the reference transcript.** Leaving it empty makes the engine transcribe the clip first, turning the first synthesis from ~1.5 s into ~40 s. The result is cached, so later calls recover.

---

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/gpt-sovits/api?action=settings` | Read effective settings |
| `POST` | `/gpt-sovits/api?action=settings` | Persist a settings patch |
| `GET` | `/gpt-sovits/api?action=models` | Discover trained weights in the checkout |
| `POST` | `/gpt-sovits/api?action=synthesize` | Synthesize one text; returns `{url, bytes, voice, cached}` |
| `GET` | `/gpt-sovits/api?action=health` | Probe the engine |
| `POST` | `/gpt-sovits/api?action=ensure-engine` | Ask the launcher to bring the engine up |
| `GET` | `/gpt-sovits/audio/<id>.wav` | Play a synthesized clip (`id` is a content digest) |

The `/tts` body follows the `api_v2.py` contract: `media_type: "wav"`, `streaming_mode: false`, `text_split_method: "cut5"`, `sample_steps`, `repetition_penalty: 1.35`, and so on. The engine **returns raw WAV bytes** — upstream has no JSON/base64 audio, `media_type` is a closed set of `wav|raw|ogg|aac`, and `mp3` is rejected with a 400.

---

## Development and checks

```sh
# Offline: syntax, module-loading contract, slot names, text pipeline, store reads,
# state directory, encoding (56 checks)
node scripts/selfcheck.mjs

# Live: real HTTP carrier plus the real engine, end to end (16 checks)
# Prefers the workspace source; --source installed tests the copy the running DSH loaded
node scripts/integration.mjs --ref <your-reference.wav>
node scripts/integration.mjs --skip-synthesis          # no engine needed, routes and validation only
node scripts/integration.mjs --ref ref.wav --gpt GPT_weights/your.ckpt --sovits SoVITS_weights/your.pth
```

> `--ref` is **required** for the synthesis checks: this repository ships no reference audio, so point it at your own.

Under `--experimental-vm-modules` the self-check additionally parses the bundle as an ES module (skipped otherwise).

> ⚠️ `integration.mjs` writes `speed` / `sampleSteps` into the **real** `settings.json`, because it exercises the real plugin. Re-check those two values afterwards.

### How the UI is attached

Both buttons live in DSH's own slots and follow DSH's own button geometry rather than inventing a look:

| Element | Slot | Placement / implementation |
|---|---|---|
| 🔊 Read-aloud button | `conversation.chat.assistant-actions` | In every assistant reply's action row (the same row as copy / branch / feedback), `order: 20`. Geometry follows the shell's `MessageFeedbackActions` (28px box, 6px padding, 15px glyph); while playing it switches to a locally drawn pause glyph |
| 🔊 Auto-read toggle | `conversation.input.left` | Composer toolbar row, `order: 30`; same 28px trigger as the shell's `VoiceInput` |
| Settings page | `settings.section` | Gear → Voice (GPT-SoVITS), `order: 60` |

**Why the toggle is not on the left.** The shell's composer row is:

```css
.row { flex-wrap:wrap; justify-content:space-between; gap:12px; padding:2px 8px 6px; }
```

Three flex children: ① permission + plan (`input.permission` + `input.plan`) ② **`input.left` (this plugin)** ③ `trailing` (model picker + send). `space-between` spreads all three across the full width, which puts the speaker between ① and ③, visually "to the right of the permission control".

Moving it means changing slots: `input.left` already *is* the second seat, so it cannot go further left; `input.right` would fold it into group ③, or `order` can adjust position within a group.

**About the icons.** DSH ships 377 icons and **none of them is a speaker, volume or sound glyph** (only Play/Pause), so the speaker is drawn locally — but on the shell's exact icon contract (`size=16`, `viewBox="0 0 16 16"`, `fill="none"`, 1px `currentColor` stroke), so it reads as part of the same family. Hover and active states come from injected CSS (`:hover` / `[data-active]`), not inline styles — inline styles cannot express either.

### Engine lifecycle: starts and stops with DSH

**The engine's life is decided by DSH**: opening DSH brings the engine up, closing DSH stops it. Nothing to manage by hand, and no orphan holding GPU memory.

The implementation is a **Python supervisor** (`lib/supervisor.py`, run through `pythonw.exe`, windowless throughout):

| Phase | Behaviour |
|---|---|
| Start | The plugin spawns the supervisor and hands it **DSH's own pid** via `--adopt-pid` |
| Readiness | The supervisor polls the port itself (a socket connect), then writes the engine pid to `$DSH_HOME/gpt-sovits/engine.pid` |
| Running | Every 2 s it checks whether DSH is still alive (`OpenProcess` + `GetExitCodeProcess`) |
| DSH closes | DSH gone → `taskkill /T /F` the engine → clean up the pid file → exit |
| Plugin unloads | The plugin's disposer runs `supervisor.py --stop`, same cleanup |
| Left over from a crash | The next DSH boot reads `engine.pid`; if the recorded DSH is dead it reaps the orphan first |

**Measured on this machine**: cold start to ready **10–26 s**; after killing the bound parent, engine and supervisor are **both gone within 1 s**, the port is released and the pid file cleaned.

**Why the old auto-start layers are gone**: an earlier version kept the engine alive *independently* of DSH (three layers: launcher / hidden wrapper / logon shortcut), because "restarting DSH takes the engine down". The requirement is now the opposite, so the scheduled task and the Startup-folder shortcut were **removed** — they kept resurrecting the engine and fought the new lifecycle.

**Starting the engine by hand** (to warm it up before opening DSH, or to run without DSH):

```sh
$DSH_HOME/gpt-sovits/start-engine.bat
```

It calls the same `supervisor.py`, but without `--adopt-pid`: the supervisor exits after readiness and **leaves the engine running**.

### Auto-read starts from the *next* reply

After switching on the composer's speaker (or "Auto-read new replies" in the settings page), **the reply already on screen is not read** — the toggle is about *new* replies, not "read this one now".

To confirm it works: leave the toggle on and send another message; the new reply speaks as soon as it lands.

### Why one request per sentence

**Symptom** (reported): with longer text, **a sentence was cut off half-way**, or **never spoken at all**.

**Cause**: **two splitters disagreed**.

| | Old behaviour | Problem |
|---|---|---|
| Client | Packed sentences into a ~110-character buffer, one request | One request could hold "the tail of this sentence" plus "the next sentence" |
| Engine | The request carried `text_split_method: "cut5"`, **splitting again** | Two different boundary sets |

The engine was synthesizing on **its own** boundaries while the client had already sent the next request on **its own** — the half-finished piece was overwritten. There was also a character-count fallback for long sentences, which cut just as badly. Measured in the diagnostic log: `speak` followed **four milliseconds later** by `play-failed` on the previous message; `play-failed` **84 times** against `played` **51 times**, so about four utterances in five were being cut off.

**The fix**:

| | Now |
|---|---|
| Client | **One request per sentence** — exactly one complete sentence each |
| Engine | **`cut0`** — explicitly told not to split |
| Long sentences | Threshold raised from a *packing* size of 110 to a safety valve `SENTENCE_SOFT_MAX = 280`; above it, break at **clause punctuation** (`，、；：—–`), never by character count |
| Playback | Still pipelined: sentence N+1 is prefetched while N plays |

### Why auto-read queues instead of preempting

**Symptom**: a sentence was cut off mid-way and replaced by the next one; the user described it as "as soon as the next sentence enters processing, the previous one is discarded".

**Diagnostic log, dozens of times over**:

```
[19:50:56.981] gate-fb4fe213  auto:true      ← text updated, gate opened
[19:50:56.982] speak  fb4fe213               ← start speaking it
[19:50:56.986] play-failed  221bbd60         ← 4 ms later the previous one is aborted
```

**Two causes, neither in the splitting layer**:

| # | Problem | Note |
|---|---|---|
| 1 | **Preemptive playback** | Auto-read called `play()`, and `play()` starts with `stop()` — so every text update killed the sentence being spoken |
| 2 | **Streaming replay** | `selectLatestMessageId` did **not** require a settled node (it fell back to the live `node.data.blocks`), so every growth triggered another read and the opening sentences repeated |

**The fix: a queue plus an offset**

| Mechanism | Role |
|---|---|
| `player.enqueue(key, text, words, complete)` | **Appends** to the playback queue instead of preempting |
| `player.drain()` | Plays the queue one clip at a time, re-checking after each, so sentences appended during playback are picked up |
| **Per-message queued offset** | A `queued` map records how many characters of each message have been handed over, so **already-queued sentences are never re-queued** |
| **Cut at the last sentence end** | A half-written sentence is not queued (it would be synthesized as a fragment and then spoken again); the tail waits for `complete` |
| Single hook returning a **primitive** `"id\|0/1"` | An object selector is a fresh identity on every render and defeats the store's change comparison; a string changes exactly when the reply grows or settles |
| Claim set meaning "**the queue owns this reply**" | It used to mean "already spoken", which under streaming dropped every sentence after the first |

**Preemption is kept** where the user asks for it: stopping with the speaker button, or clicking another reply's 🔊.

### Streaming and the summary: two strategies

A DSH reply is really **two different kinds of output**, so there are two strategies:

| Phase | Text shape | Strategy | Why |
|---|---|---|---|
| **Processing** | **Streams in**, step by step | **One sentence per request + `cut0`**, queued | Audio starts as early as possible, and the engine cannot disagree with the client's boundaries |
| **Final summary** | **One large block** | **Packed into blocks + `cut5`**, the engine splits inside a block | One request per sentence would pay the per-request cost dozens of times and the engine would fall behind the listener |

**Measured** (same four sentences, real engine):

```
streaming, one sentence   cut0  HTTP 200  180524 B  RIFF ✅   888 ms
settled, packed block     cut5  HTTP 200  491564 B  RIFF ✅  1619 ms
```

Packed is **one request and 1.6 s**; sentence by sentence is four requests and roughly **3.4 s** — twice as slow.

### A new turn cancels everything from the previous one

**Signal**: the shell's own turn counter, `snapshot.timeline.turnOrder` (the shell reasons about turns with exactly this: `if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false`).

**Behaviour** when it grows:

1. `CLAIMED.clear()` — so the new reply can be claimed normally
2. **`player.stop()`** — stop the current clip, clear the pending queue, clear every per-message offset
3. **`generation += 1`** — discard a synthesis already in flight for the old turn, so it cannot play after the new one has begun

**Why `stop()` and not a gentle queue clear**: a gentle clear leaves an awkward state — the queue is empty but the current sentence is still playing, and its continuation will never arrive. The requirement is to cancel **all** the previous processing and playback, so at a turn boundary the new turn outranks the tail of the old one.

**Nothing is interrupted within a turn.** `stop()` runs only when `turnOrder` grows.

### How symbols become speech

The engine **drops or misreads symbols**, so these rewrites happen in the plugin. Order is part of the correctness:

| Rule | Input → output | Why this position |
|---|---|---|
| File extension | `cmd.exe` → `cmd点exe` | Must precede `cleanForSpeech`, which collapses paths and long identifiers |
| Fraction | `3/4` → `4分之3` | Chinese reads the **denominator first**; must precede the "or" rule |
| Slash (rest) | `是/否` → `是或否`, `是/否/待定` → `是或否或待定` | Once real fractions are excluded, "or" is the safe default |
| Backslash | `a\b` → `a杠b` | A path separator reads as "杠" |
| Version | `v2.7.0` → `v2点7点0` | Must precede the generic decimal rule |
| Range | `3-10` / `3 ~ 10` / `3–10` → `3到10` | `\b` keeps it off identifiers like `abc-def` |
| Date | `2024-10-03` → **unchanged** | **Masked, then restored.** A lookahead was tried and was not reliable: the date came out as `2024-10到03` |
| IP | `127.0.0.1` → `127点0点0点1` | Before the generic decimal rule |
| Decimal | `36.5` → `36点5` | Last, so it only sees what is left |

**URLs, paths and UUIDs are masked too**, otherwise the slash rule reads `https://a.com/b` as "链接 或 或 a点com 或 b".

> **The slash trade-off**: `3/4` always reads as a fraction. A genuine ratio cannot be told apart from one, so spell it out in the source text when the other reading is wanted.

### Startup greeting

The plugin speaks a greeting after it starts. It is **not a bundled clip but a real synthesis** — deliberately, because it does two jobs at once:

| Purpose | Note |
|---|---|
| **① It proves the plugin is alive** | A real synthesis walks the whole chain: plugin loaded → engine answering → weights and reference clip resolvable. If any link is broken, nothing plays |
| **② Engine warm-up (the more important one)** | GPT-SoVITS loads weights, BERT and CNHuBERT on the **first `/tts`** of a session — that is the 10–30 s cold start. The greeting pays it up front, so your first real question is already fast |

#### Polling instead of guessing at timing

**This design exists because three earlier attempts failed.** Every one of them guessed *when* the engine would be ready:

| Attempt | Approach | Why it failed |
|---|---|---|
| ① | Client waited 1.2 s after mount, then synthesized | The engine was idle and no model load had started; that 1.2 s was pure waste |
| ② | Host warmed up 1.5 s after boot | **Measured: the engine needs ~19 s to bind its port** — the request hit nothing, so the greeting was lost on every cold start |
| ③ | Poll the engine for readiness | Still assumed boot was the only competitor; and a failure left the in-flight latch set, so it was **permanently stuck** |

**The rule is now one sentence: produce the greeting when the engine is idle, and stand down the moment it starts working.**

| Stage | Parameter | Note |
|---|---|---|
| Client asks | **every 500 ms** | The host answers **immediately** with a `state`; nothing blocks, nothing piles up |
| Host samples engine state | **every 100 ms** | **Reads local variables only** (`engineQueueDepth` plus busy/idle timestamps), so it costs nothing |
| Engine reachability probe | **every 2 s** (20th tick of the 100 ms beat) | `probeHealth` is an HTTP round trip; ten of those a second would compete with the synthesis they are meant to observe |
| Engine starts working | **stands down at once** | `greetingGate()` returns `engine-busy`; the greeting never competes for the engine |

The `state` from `?action=greeting` says exactly what it is waiting for:

| state | Meaning |
|---|---|
| `probing` | Reachability not confirmed yet |
| `engine-down` | The engine is not up |
| `engine-busy` | **The engine is working; the greeting stands down** |
| `synthesizing` | The greeting is being generated |
| `ready` | Audio is ready, with a `url` |
| `disabled` | Switched off in the settings |

**Measured** (real engine, cold start):

```
t+0.0–2.1s  state=probing
            [info] engine busy                      ← confirmed idle, synthesis begins
            [info] greeting ready (129324 bytes) — engine warm
t+4.6s      ✅ READY  129324 B  RIFF                ← a real WAV
```

#### A fatal trap: never nest the engine queue

`withEngine` is a **serial chain** and `speak()` **queues internally**, so this **deadlocks**:

```js
await withEngine(() => speak({ ... }))   // ❌ the outer entry holds the chain while the inner waits for it
```

Measured symptom: `greeting.state` **stuck at `synthesizing`**, `busy=True`, no progress for over 60 s. The fix is to **call `speak()` directly** and let it queue once, internally.

> An assertion pins this: **exactly one `withEngine(` call site in the whole file**, and `withEngine(() => speak` is forbidden.

| Other behaviour | Note |
|---|---|
| Once per session | A `sessionStorage` mark plus a module latch (against duplicate tabs). **Refreshing does not repeat it**; reopening DSH does |
| Text | Default 「你好，欢迎回来」, editable and switchable (`greetOnStart` / `greetText`) |
| On failure | The host still answers **HTTP 200 + `ok:false`** with a `state`. A greeting is a nicety; it must not make the plugin look broken |

### Where the gaps between sentences come from

**Symptom** (reported): the pause between sentences is too long.

**Two sources, handled separately**:

| Source | Why a gap appears | Fix |
|---|---|---|
| **Serial rhythm** | The old flow was `await synthesis` → `await playback` → next, so every sentence began with a synthesis-sized hole | **Prefetch pipeline**: while sentence N plays, N+1 and N+2 are already synthesizing (`PREFETCH_AHEAD = 2`) |
| **Very short sentences each taking a request** | "好的。" "然后呢。" "完成了。" each cost a full synthesis round trip | **Packing merges them** into blocks up to `SENTENCE_BLOCK_MAX = 160` |

**On "parallelism"**: `api_v2.py` is a **GIL-bound Python process and one synthesis cannot be parallelized internally**, so the only parallelism is at the **request** level. The prefetch window is therefore deliberately small: the engine handles one request at a time (`workers=1`), so more outstanding requests do not make it faster, they only make "cancel the previous turn" more sluggish.

**Regression test** (slows playback down, then asks how many syntheses were ever in flight):

```
✓ synthesis runs ahead of playback, so sentences do not gap — 3 requests, up to 2 in flight at once
```

A serial implementation can never exceed one, so this assertion really does pin the fix.

### Live status in the settings page

**Settings → Voice (GPT-SoVITS)** opens with a **live status** panel, refreshed every 2 s:

| Field | Question it answers |
|---|---|
| Engine | Is it reachable |
| **Generating** | Is the engine busy (single worker, so busy means queued) |
| **Startup greeting** | `idle` / `probing` / `engine-down` / `engine-busy` / `synthesizing` / `ready`, with bytes and any error |
| Active voice | Voice name plus **whether the reference clip exists** |
| **Loaded weights** | Which GPT / SoVITS pair the engine currently holds |
| **Recently generated** | Time, duration and text; `cached` means it never reached the engine |

**Why it exists**: "the greeting did not play" was previously **impossible to diagnose from outside** — models loading, a preview holding the single worker, and a clip synthesized but never played all look identical, and only a log file could tell them apart.

> Backed by the `GET /gpt-sovits/api?action=status` route.

### Engine console

The engine's full output is captured and shown **inside the settings page**.

| Tab | Content |
|---|---|
| **Engine output** | `api_v2.py` stdout/stderr: TTS config, weight loading, the target text of every synthesis, access lines, tracebacks |
| **Launcher** | The supervisor's decisions: spawn command, engine pid, `ready=True`, `watching DSH pid N`, stop records |
| **Generated** | Each synthesis with time / duration / voice / text; `cached` means it never reached the engine |

**Why not a separate console window** — rejected for two hard reasons:

| Problem | Note |
|---|---|
| **Steals focus, and closing it kills the engine** | The window **is** the process's console: closing it terminates the engine |
| **Previously invisible anyway** | The supervisor sent the engine's output to `DEVNULL`, so engine-side problems could not be seen from the UI at all — the log said only `ready=True` |

**Why not a right-sidebar tab either** — also tried, also rejected:

| Problem | Note |
|---|---|
| **DSH reported a background task as running** | Registering a tab makes the UI show a task in progress |
| **The plugin could fail to load** | `sidebarRightTabs` is a host-composed client capability; on a build without it the plugin loads with the tab missing and can fail entirely |

**Final design: embedded in the settings page.** Plain slot content, no shell capability, cannot affect the boot.

Output goes to `$DSH_HOME/gpt-sovits/engine-output.log` (truncated at every start, so it shows the current run), with three refresh settings — **1.5 s** (default), **0.5 s**, and **manual** — plus pause and refresh-now.

#### The mojibake fix (reported)

**Symptom**: every Chinese line in the console was garbled.

**Cause** (raw bytes measured):

```
read as UTF-8:  address ('127.0.0.1', 9880): ͨ��ÿ���׽��ֵ�ַ(Э��/�����ַ/�˿�)ֻ����ʹ��һ�Ρ�
read as GBK:    address ('127.0.0.1', 9880): 通常每个套接字地址(协议/网络地址/端口)只允许使用一次。
```

**Python on Windows encodes stdout with the console code page (cp936)**, while the panel decoded UTF-8 — so every Chinese line was garbled, **including the errors, which are exactly what a reader needs when something goes wrong**.

**Two-layer fix**:

| Layer | Approach |
|---|---|
| Root cause | The supervisor sets `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1` when spawning the engine — **the engine emits UTF-8** |
| Fallback | The panel detects the replacement character `U+FFFD` and re-decodes as GBK — **tolerates a log left by an older supervisor** |

### Traps only a real machine exposes (all fixed)

These are not speculation — they were measured from diagnostic logs. Each one maps to a symptom that looks like "everything is fine, it just doesn't speak":

| # | Trap | Symptom | Fix |
|---|---|---|---|
| 1 | `turnTail` is a list slot, **rendered once per turn**, so N drivers raced for one single-channel player | Speaks sometimes | **Module-level claim set**: whichever copy sees a reply first owns it |
| 2 | A **per-instance** `armed` flag deciding "auto-read just switched on" | N copies could not see each other → **all of them only recorded, none spoke** | Gate on the **persisted "last read" mark** (globally shared) |
| 3 | A component **returned before calling a hook** (`if (typeof turn !== "number") return null` ahead of `useChat(...)`) | Broke the rules of hooks → React threw → **the error boundary silently unmounted it** → button and driver **did not exist at all** | Every hook runs unconditionally, plus a **static assertion** forbidding an early return before the first hook |
| 4 | `turnTail`'s `turn` prop **measured as an `object`, not a number** | The type test always held → the driver never worked | **Stop depending on that prop**; coordinate through the claim set |
| 5 | Diagnostic probes with **no throttling**, one HTTP request per render | Thousands of log lines and synchronous disk writes per page load | Deduplicate per event name and report once per copy |
| 6 | The engine was tied to DSH's lifetime | **Silent every time DSH restarted** | The engine now starts and stops with DSH |
| 7 | **Two splitters disagreeing**: the client packed sentences to 110 characters, the engine re-split each request with `cut5` | A sentence cut off mid-way, or never spoken | **One request per sentence + `cut0`** |
| 8 | **The greeting waited on a fixed 1.5 s delay** while the engine needs ~19 s to bind its port | Lost on every cold start | Poll the real state instead of guessing |
| 9 | **A failed greeting never released its in-flight latch** | The status stayed `synthesizing` forever with no retry | Release it in `finally` on every path |
| 10 | **`withEngine(() => speak(...))` deadlocked the serial engine queue** | `busy` for over 60 s with no progress at all | Call `speak` un-nested; an assertion pins one `withEngine(` call site |
| 11 | **`tasklist` text matching** in the supervisor reported a live process as dead | The supervisor exited right after starting the engine, leaving it unmanaged | `OpenProcess` + `GetExitCodeProcess` |
| 12 | **`netstat` parsing** returned an empty set for a live listener | Adoption of an already-running engine failed | `GetExtendedTcpTable` |
| 13 | **Liveness decided through a system proxy** | `urlopen('127.0.0.1:9880/control')` was answered by the proxy (404) while nothing was listening | Bypass proxies for loopback |
| 14 | **Leaving the settings page stopped playback** (its unmount handler called `player.stop()`) | The greeting kept disappearing when the settings page was opened and closed | The unmount handler only marks the component dead |

Regression coverage: a fake store, fake React effects and a fake `Audio` verify "3 drivers mounted, **exactly 1** speaks", "silent while switched off", "an existing reply is not re-read", "a growing reply is queued sentence by sentence with nothing cut off", "an unterminated sentence waits", and "a settled reply is packed while streaming is not".

### State directory and what needs a reload

| Topic | Note |
|---|---|
| Default state location | `$DSH_HOME/gpt-sovits`; falls back to `~/.dsh/gpt-sovits` when the host process cannot see `DSH_HOME` |
| Host-half edits | `dsh-gpt-sovits` is a `file:` dependency, and pnpm **copies** rather than links it, so editing the workspace does not affect the installed copy. Re-sync by overwriting `~/.dsh/profiles/desktop/node_modules/dsh-gpt-sovits/`, or `remove` then `add` |
| When the client half appears | The client bundle is composed into the boot graph: **refresh the page** |
| When the host half reloads | Installation mounts the plugin immediately (routes answer at once), but already-loaded module code **does not hot-reload** — code changes need a DSH restart |

### Known limitations

- **On Windows it enumerates drive letters to auto-discover the engine** (`engineRootCandidates()` in `lib/index.js`). With no checkout directory configured and no `DSH_SOVITS_ENGINE_ROOT` set, the plugin **tries to read the root of `A:\` through `Z:\`** and keeps directories whose name matches `/^gpt[-_]?sovits/i` as candidates.

  What it actually does is narrower than it sounds:

  | Question | Behaviour |
  |---|---|
  | What is read | **Only the top level of each drive root** (`readdirSync`) — no recursion, no walking of directory trees |
  | What is taken | **Directory names only**, for pattern matching; no file contents |
  | Missing drives | Empty floppy drives (`A:\`, `B:\`) are skipped inside `try`/`catch` — reading one can raise the "insert a disk" prompt on some machines |
  | When it runs | Only when the model list is requested or the settings page opens; `listWeights()` stops at the first valid checkout |
  | Does it write | **No.** There is no write of any kind on this path |

  **To stop the scan entirely**: set the checkout directory in the settings page (or export `DSH_SOVITS_ENGINE_ROOT`). Explicit configuration is tried first, and a hit there means the drive scan never runs.

  Why it works this way: the official Windows package is an archive that people unpack wherever there is room — often a secondary drive root — so there is no fixed install location; and the path has to be readable by the **engine process**, which makes hand-typed paths error-prone.

- **During a cold engine start, `ping 127.0.0.1` console windows flash on screen repeatedly** — this is **expected behaviour, not a fault**, but it is ugly.

  It comes from the wait loop in the launcher, `start-engine.bat`: it uses `ping -n 4 127.0.0.1 >nul` as its delay (**`timeout` cannot be used** — it exits immediately when stdin is redirected, see the traps above). `ping.exe` is a console program, so **every poll spawns a new process**, and each one may flash a window. The longer the models take to load, the more flashes — typically **30–45** on a cold start (about 4 s apart, up to 60 tries).

  | Situation | Flashes? |
  |---|---|
  | Engine **not yet up** when DSH starts | ✅ Yes, until the port answers |
  | Engine **already running** | ❌ No — the launcher sees the port listening and **returns immediately without polling at all** |
  | Started by the scheduled task / Startup folder | Normally no (`run-hidden.vbs` uses `shell.Run(..., 0, ...)` to hide the window), but it can still flash if the plugin's own path is running at the same time |

  **To stop seeing it**, pick one:

  1. **Start the engine before DSH** — while the engine is up, the plugin's path never polls (simplest)
  2. **Let the engine start at logon** — the scheduled task or Startup folder brings it up, so the port is already listening by the time DSH starts
  3. **Turn off the plugin's auto-start** — delete `GPT-SoVITS 语音引擎.lnk` from the Startup folder and launch `启动语音引擎.cmd` by hand instead
  4. **Replace the delay** — swap `ping -n 4 127.0.0.1 >nul` on line 92 of `start-engine.bat` for another wait (for example PowerShell's `Start-Sleep`)

  > Why this was not simply "fixed" in the plugin: with `windowsHide: true` combined with `detached: true`, whether a console window created by the child itself is suppressed varies across Windows versions. Getting that logic wrong costs a **dead engine and total silence**, which is far worse than a few flashing windows. So the behaviour and the ways out are documented here instead of gambling on a launcher that works.

- The synthesis cache is an in-process `Map` plus WAV files on disk, capped at 120 entries; a restart clears the index (the WAVs stay in `audio/`).
- Playback rate depends on the browser's `preservesPitch`; where it is missing, playback is pinned to 1× (the settings page says so).
- With an empty `prompt_text` the first synthesis is slow (the engine transcribes the reference first); the cache covers it afterwards.

---

## How it came about

**This whale girl installed a voice for herself.**

Every line of this plugin was written inside DSH, turn by turn, by **DeepSeek (`deepseek-flash`, the official DeepSeek provider)** in conversation with the author — reading the shell's source to pin down the slot contract, measuring the real shape of the store, chasing down a bug that looked exactly like "everything is fine but it does not speak", and filling in i18n, self-checks and integration tests through failure after failure.

The author's part was: stating what was wanted, setting up the engine and the voices, clicking the buttons on a real machine, and sending back the error screenshots. **The voice is trained by the author; the voice box is installed by itself.**

Worth noting: it **did not understand its own host at first**. Its opening attempt treated `snapshot.legacy.nodes` as the node container — a layout left behind by a different DSH version and a different plugin — and got it wrong four times in a row. What finally fixed it was a **diagnostic probe** written into the host that printed the container's real member list. That trap table above is what came out of it.

---

## ✅ The environment the tests passed on

> **The table below is the environment this code actually ran in with every test passing** — not a "recommended configuration", and not copied from documentation.
>
> Every row was measured on the machine; the **56 offline checks** and the **16 live-engine integration checks** both passed there, and the button and auto-read were confirmed by the author clicking them on this same machine.
>
> A different OS, DSH version or GPU is **plausible but untested** — if you hit trouble, please open an issue with your environment details.

| Item | Measured value |
|---|---|
| OS | **Windows 11 Pro** `10.0.26200` (64-bit) |
| Host | **DSH desktop build** (Electron), profile = `desktop` |
| Host client contract | `@deepseek-ai/dsh-client-*` **0.2.0-rc.2** |
| Node.js (plugin runtime) | **v24.21.0** (DSH's bundled runtime; `engines` asks for `>=22`) |
| GPU | **NVIDIA GeForce RTX 5070 Ti**, 16303 MiB VRAM, driver 616.92 |
| Python (engine side) | **3.9.13** (GPT-SoVITS integrated runtime) |
| PyTorch / CUDA | **2.7.0+cu128** / **CUDA 12.8** |
| GPT-SoVITS checkout | `GPT-SoVITS-v2pro-20250604-nvidia50` (with every `GPT_weights` … `v4` and `SoVITS_weights` … `v4` directory present) |
| Model version actually used | **v2Pro** |
| Engine endpoint | `http://127.0.0.1:9880` |
| Plugin version | v0.2.0 |

**Measured latency** (same machine, `sample_steps 32`, reference transcript filled in):

| Scenario | Time |
|---|---|
| Engine cold start (loading weights) | ~**12–30 s** |
| First synthesis (reference not yet transcribed) | ~**20 s** |
| Every later new sentence | **1.0–1.6 s** |
| A repeated sentence (cache hit) | **0 s** |

> Engine-side VRAM measured at roughly **2.7 GB** (v2Pro weights + BERT + CNHuBERT).

---

## Credits and third-party code

This project is MIT-licensed. **One part of it is substantive reuse of someone else's
implementation**; the rest is interface contracts and layout constants. **The full
list — exact files, exact statements, and what was changed — is in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).** Summary:

| Source | License | What was reused |
|---|---|---|
| [`MaRi23333/dsh-fish-tts`](https://github.com/MaRi23333/dsh-fish-tts) | MIT | **The text-cleaning regular-expression chain in `cleanForSpeech` — around a dozen patterns byte-identical** (from its `cleanForTts`), plus the `window.__ModuleLoader__.load` bundle shape |
| [`fangqian616/dsh-say`](https://github.com/fangqian616/dsh-say) | MIT | **The GPT-SoVITS `/tts` request body and defaults**, and the `GET /control` liveness probe where an HTTP error means alive (from its `lib/engines/gptsovits.js`) |
| DSH's bundled `@deepseek-ai/dsh-client-*` | MIT | The plugin registration pattern (`ctx.slots.inject` / `register` / `settings.section`), the injected-stylesheet approach, the **geometry constants for the action row and icon contract** (28px box / 6px padding / 15px glyph / `size=16` / 1px `currentColor`), and the one line that says to read `snapshot.nodes.values()` |
| [`MeteorNOX/DeepSeek-Balance-Whale-Widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | MIT | The two-step `DSH_HOME \|\| ~/.dsh` state-directory fallback |
| [`RVC-Boss/GPT-SoVITS`](https://github.com/RVC-Boss/GPT-SoVITS) | MIT | The `api_v2.py` endpoint contract (no code copied) |

Read for reference only, **no code reused**, but worth thanking:
[`TaoruiLiu19/dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv) (it demonstrated
that the host/client split was viable), [`maoyuching/dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat),
and [`haide-D/SillyTavern-EchoCore`](https://github.com/haide-D/SillyTavern-EchoCore).

**Only runtime dependency**: `@deepseek-ai/schemastery` (MIT, © DeepSeek), installed
from the registry rather than vendored.

---

## License and third-party notices

- This is a **third-party community plugin**. It is **not affiliated with, endorsed by, or partnered with** DeepSeek, GPT-SoVITS (RVC-Boss), or their maintainers. "DeepSeek", "DeepSeek Harness" and "GPT-SoVITS" belong to their respective owners and are used here descriptively only.
- This plugin **does not distribute or host any model weights, reference audio or synthesized audio**, and it contains no voice-cloning service. It only connects **your own** local engine to the DSH interface.
- **Use only voices you have the right to use.** Do not clone, imitate or synthesize the voice of a public figure, celebrity or any other person without authorization. Rights and compliance for reference audio and trained weights rest entirely with the user.
- **Synthesized audio can be mistaken for a real person speaking**: if you publish it, disclosing that it is AI-generated is encouraged.
- The code here is released under **MIT**. Your models, reference audio and generated audio are **not** covered by that license.

---

## Appendix: how each feature is implemented

The sections above explain **why**; this one explains **how** — files, functions, parameters, data structures. Start here if you intend to change the code.

### Layout and division of labour

```
lib/
├─ index.js        Host half: HTTP routes, engine calls, weight switching, supervisor control, log reading
├─ client.js       Client half: slot components, player and queue, text pipeline, settings UI
└─ supervisor.py   Supervisor: windowless engine start, readiness wait, lifetime binding, log capture
scripts/
├─ selfcheck.mjs   56 offline checks (static assertions plus behavioural tests in a vm sandbox)
└─ integration.mjs 16 live checks (a real HTTP carrier plus the real engine)
```

**Why three files**: the host and client halves run in **different processes and environments** (host is Node, client is the browser). `supervisor.py` is a third layer because it must outlive the plugin's own process in order to own the engine's lifecycle.

### 1. Per-reply read-aloud button

| Item | Implementation |
|---|---|
| Slot | `conversation.chat.assistant-actions`, `order: 20` |
| Props | `{ messageId, useChat, t }` — injected by the shell, not supplied by the plugin |
| Text | One hook call: `useChat((snapshot) => selectText(snapshot, messageId))`, returning a **primitive string** |
| Icon | Drawn locally (the shell's 377 icons contain **no speaker**), on the shell's icon contract: 16px viewBox, `fill:none`, 1px `currentColor` |
| Geometry | Mirrors the shell's own action buttons: 28px box, 6px padding, 15px glyph |
| Position | `placeAfterBranch()` moves the button **after the branch button** once mounted (the slot hands it a seat before it) |
| Always visible | Clears the action row's inline `opacity` (the shell hides the whole row under `[data-actions-reveal=hover]`) |

**Why a DOM move instead of CSS `order`**: the row also holds a tooltip wrapper, a visually-hidden reason and the end-info cluster, so sorting it in CSS would be fragile. Moving our own node is one DOM operation, and it degrades to leaving the button alone.

### 2. Text pipeline (`lib/client.js`)

Executed in order, and **the order is part of the correctness**:

```
raw Markdown
  ↓ speakNormalize(text, words)
  ↓ cleanForSpeech(..., words)
  ↓ splitIntoBlocks() / splitIntoChunks()
  ↓ playback queue
```

**`speakNormalize(text, words)`** — symbol-to-speech, with a strict internal order:

| Step | Action | Why here |
|---|---|---|
| 1 | **Mask dates** (`2024-10-03` → placeholder) | Otherwise the range rule cuts it into `2024-10到03` (a lookahead was tried and was not reliable) |
| 2 | **Mask URLs / paths / UUIDs** | Otherwise the slash rule reads `https://a.com/b` as "链接 或 或 a点com 或 b" |
| 3 | Extensions → `点exe` | Must precede `cleanForSpeech`, which collapses long identifiers |
| 4 | Fractions → `4分之3` | Must precede the "or" rule, or `3/4` reads as "3 或 4" |
| 5 | Remaining slashes → `或`; backslashes → `杠` | Real fractions are excluded, so "or" is the safe default |
| 6 | Versions → `v2点7点0` | Must precede the generic decimal rule |
| 7 | Ranges → `3到10` | `\b` keeps it off identifiers like `abc-def` |
| 8 | IPs → `127点0点0点1`, decimals → `36点5` | Last, so they only see what is left |
| 9 | **Restore masked tokens** | Read back the original form |

**`cleanForSpeech(text, words)`** — strips Markdown: fenced code blocks dropped whole, inline code unwrapped, images dropped, links unwrapped to their text, URLs/paths/UUIDs/long identifiers replaced with words, heading/quote/list/rule markers removed, HTML tags removed, emphasis unwrapped, whitespace collapsed.

**`splitIntoChunks(text)`** — splits on sentence terminators (`。！？!?；;…`) and newlines. An oversized sentence is broken **at clause punctuation** (`，、；：—–`) first, with `SENTENCE_SOFT_MAX = 280` as the safety valve.

**`splitIntoBlocks(sentences, max)`** — settled packing: merges consecutive whole sentences into blocks of up to `SENTENCE_BLOCK_MAX = 160` characters. **Never splits inside a sentence**; a single sentence over the limit becomes its own block.

### 3. Player and queue (`SovitsPlayer`)

```
pending[]     items to speak: { text, key, splitMethod }
queued        Map<messageId, characters already queued>
draining      whether a drain is running (singleton)
generation    bumped by stop() to discard in-flight synthesis
```

**`enqueue(key, text, words, complete)`** — the single entry point for auto-read:

1. Read the message's **queued offset** (`queued.get(key)`) and take the new part
2. Cut at the **last sentence terminator** (relaxed to a paragraph newline when `complete`). A half-written sentence is not queued, or it would be synthesized once and spoken again
3. `cleanForSpeech(speakNormalize(...))`
4. **Route**: `complete ? packed blocks + cut5 : one sentence per request + cut0`
5. Append to `pending`, update the offset, trigger `drain()`

**`drain(words)`** — the prefetch pipeline:

```
keepAhead()                     up to PREFETCH_AHEAD=2 syntheses in flight
while (ahead is not empty):
  item = ahead.shift()
  url  = await item.promise     ← that synthesis started earlier and overlapped the previous clip
  keepAhead()                   ← refill at once, so the next synthesis overlaps this clip
  await playClip(url, generation)
  if (generation changed) return    ← superseded by stop()
```

**The `finally` compares drain's own `generation`** before restarting — writing `this.generation === this.generation` would resurrect a cancelled queue (this was hit).

**`stop()`** — stop the audio, clear `pending`, clear `queued`, `generation += 1`.

### 4. The auto-read driver

`conversation.chat.turnTail` is a **list slot** and the shell **renders it once per turn**, so N copies exist while the player is single-channel. Coordination:

| Mechanism | Role |
|---|---|
| `CLAIMED` (module-level Set) | A reply **belongs to the queue** until the queue has finished it |
| `lastRead` (localStorage) | The "already read" mark, **surviving page refreshes and session switches** |
| `selectLatestState` | One hook call returning the **primitive** `"<id>\|<0/1>"` — an object selector is a fresh identity every render and defeats the store's change comparison |
| `turnCount` | `snapshot.timeline.turnOrder.length`, which is what the shell itself reasons about turns with |

**Every hook runs unconditionally, before any early return** — breaking the rules of hooks makes React throw and the error boundary unmount the component silently, which is the real reason the button once did not exist at all.

### 5. Cancelling the previous turn

```
turnOrder.length grows
  → CLAIMED.clear()
  → player.stop()         stop audio, clear the queue and offsets, generation+1
  → diag('turn-reset')
```

`stop()` runs only at a **turn boundary**; **nothing is interrupted within a turn**. It also discards in-flight synthesis, so the old turn's audio cannot play after the new one has begun.

### 6. Split routing on the host (`lib/index.js`)

The request carries `splitMethod`, which the host maps to the engine parameter:

```js
text_split_method: splitMethod === 'cut5' ? 'cut5' : 'cut0'
```

| Source | Sends | Reason |
|---|---|---|
| Streaming text | `cut0` | Already a complete sentence; splitting again means two boundary sets |
| Settled summary (packed) | `cut5` | The engine cuts inside a block |
| Manual 🔊 click | `cut5` | A whole block of text at once |
| **Unspecified** | **`cut0`** | A default must not split: an unexpected split is what caused truncation |

### 7. Weight switching

- Weights are **global engine state** (`set_gpt_weights` / `set_sovits_weights`, **GET only**)
- `activeGpt` / `activeSovits` are remembered, and a **pair that has not changed is skipped** — otherwise every read would reload the model
- `api_v2.py` runs `workers=1`, so every engine operation goes through one **serial chain**, `withEngine()`

> **Never nest `withEngine`**: `speak()` queues internally, so `withEngine(() => speak(...))` makes the outer entry hold the chain while the inner waits for it — a **deadlock** (measured: stuck for over 60 s). An assertion pins "exactly one `withEngine(` call site in the whole file".

### 8. Startup greeting (0.5 s poll, 0.1 s state sampling)

```
client                                host
  │ GET ?action=greeting  ────────→  greetingGate()
  │                                  ├─ disabled        switched off
  │                                  ├─ ready           clip exists
  │                                  ├─ synthesizing    in progress
  │                                  ├─ engine-busy     ← engine working, stand down
  │                                  ├─ probing         reachability unconfirmed
  │                                  └─ idle            → start synthesizing
  │ ←── { state, url?, bytes? } ────  (returns immediately, never blocks)
  │
  └─ asks again every 500 ms until a url arrives, then plays it and stops
```

| Parameter | Value | Location |
|---|---|---|
| Client poll interval | **500 ms** (up to 240 attempts ≈ 2 minutes) | `GREETING_RETRY_MS` / `GREETING_ATTEMPTS` |
| Engine state sampling | **100 ms** | `FAST_MS` |
| Reachability probe | every 2 s (the 20th tick) | `PROBE_EVERY` |

**Why the state sampling is split in two**: the busy check **reads local variables only** (`engineQueueDepth` plus timestamps) and costs nothing, while reachability is an HTTP round trip and **ten of those a second would compete with the synthesis they observe**, so it runs on the slow beat.

**Once per session**: a `sessionStorage` mark plus a module latch (against duplicate tabs). Refreshing does not repeat it; reopening DSH does.

**Failure is not an error**: the host answers HTTP 200 + `ok:false` + a `state`. A greeting is a nicety and must not make the plugin look broken.

### 9. Engine lifecycle and the supervisor (`lib/supervisor.py`)

```
plugin starts → spawn pythonw.exe supervisor.py --adopt-pid <DSH pid> ... (detached, windowless)
              → supervisor: if the port is held but unresponsive, clear it; otherwise spawn api_v2.py
              → poll readiness (socket connect, not ping) → write engine.pid
              → every 2 s, OpenProcess to check DSH is still alive
DSH exits     → kill the engine → remove the pid file → exit
next boot     → read engine.pid; if the recorded DSH is dead, reap the orphan first
```

**Win32 calls used** (all via `ctypes`, so no process is spawned):

| Purpose | API | Why not shell out |
|---|---|---|
| Process liveness | `OpenProcess` + `GetExitCodeProcess` | `tasklist` text matching **reported a live process as dead**, so the supervisor exited right after starting the engine and left it unmanaged |
| Port owner | `GetExtendedTcpTable` | `netstat` parsing **returned an empty set for a live listener** |

**Windowless**: `pythonw.exe` + `CREATE_NO_WINDOW` with stdout/stderr redirected to a file. An earlier batch launcher used `ping` as its delay, and `ping.exe` is a console program, so a cold start flashed 30–45 windows.

**UTF-8**: the engine is spawned with `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`, because Python on Windows otherwise emits cp936 while the panel decodes UTF-8 — mojibake.

**Proxy bypass**: `urllib` reads the system proxy by default, and the measured proxy answered `127.0.0.1:9880/control` with 404 **while nothing was listening on that port at all**. Both the supervisor and the plugin bypass proxies for loopback.

### 10. Routes (all loopback-only)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `?action=settings` | Read settings |
| `POST` | `?action=settings` | Persist settings (origin checked) |
| `GET` | `?action=models` | Discover trained weights in the checkout |
| `POST` | `?action=synthesize` | Synthesize one text; returns `{ url, bytes, cached }` |
| `GET` | `?action=health` | Probe the engine |
| `POST` | `?action=ensure-engine` | Ask for the engine to be started |
| `GET` | `?action=greeting` | Greeting state / clip (**returns immediately**) |
| `GET` | `?action=status` | Engine, busy flag, greeting, weights, synthesis history |
| `GET` | `?action=logs` | Engine output + launcher log + transcript (`&lines=N`, capped at 2000) |
| `GET` | `/gpt-sovits/audio/<id>.wav` | Serve a synthesized clip (`id` is a content digest) |

### 11. Synthesis cache

- **Key**: a digest of `text + voice name + GPT weights + SoVITS weights + reference clip + reference transcript + reference language + text language + speed + sampling steps + engine URL`
- **Two tiers**: an in-process `Map` (120 entries, FIFO eviction) plus WAV files on disk (`$DSH_HOME/gpt-sovits/audio/`)
- **Why the weights are in the key**: the same sentence is a **different clip** under a different trained model, so the two must not be substituted for each other

### 12. Self-check and integration tests

| | Offline self-check | Live integration test |
|---|---|---|
| File | `scripts/selfcheck.mjs` | `scripts/integration.mjs` |
| Checks | **56** | **16** |
| Method | Static assertions plus real functions executed in a `vm` sandbox | A local HTTP carrier that routes by `kind`/`path`, driving the real engine |
| Covers | Syntax, module contract, slot names, text pipeline, (de)serialization, encoding, store reading, deadlock and hook-order guards | Route contract, validation, weight switching, greeting polling, status/logs, synthesis and caching |
| Needs no engine | ✅ | Partly, with `--skip-synthesis` |

**What the sandbox buys**: it asserts **behaviour**, not text. The queue test, for instance, makes `stop()` **throw** — so if the implementation ever stops playback while a reply grows, the test fails immediately.
