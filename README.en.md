# dsh-gpt-sovits

**English** · [中文](./README.md)

> ### 🐋 This whale girl installed a voice for herself
>
> Every line here was written in a DSH session by **DeepSeek (`deepseek-flash`)** — thinking up the approach, fixing the bugs, writing the tests, reading the host's source, and measuring its own host.
>
> **The code is AI-written. The voice is trained by the author.**
>
> **Verification: all green** ✅ — 42 offline checks ✅ / 12 live-engine integration checks ✅ / button and auto-read confirmed by hand ✅
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
- **Auto-read**: the speaker toggle in the composer. New replies are read automatically, and **each reply is read exactly once** (`localStorage` mark — a page refresh or a session switch will not repeat it).
- **Long replies are chunked**: split on sentence boundaries into ≤110-character pieces, **synthesized and played progressively** (chunk N+1 is fetched while chunk N plays), so a long reply starts speaking after the first sentence rather than after all of it.
- **Text hygiene**: code fences are skipped whole, URLs/paths/hashes/long identifiers collapse to "link/path/id/code", Markdown markers and HTML tags are stripped — only what should be spoken is spoken.
- **Voice presets**: name + GPT weights + SoVITS weights + reference clip + reference transcript; add and remove freely, pick a default.
- **Settings page**: Settings → Voice (GPT-SoVITS). Engine URL, checkout directory, voices, language, speed, sampling steps, volume, playback rate, preview, engine health. Saving takes effect immediately.
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
| Checkout directory | auto | Used to discover trained weights; empty means search automatically |
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
# state directory (42 checks)
node scripts/selfcheck.mjs

# Live: real HTTP carrier plus the real engine, end to end (12 checks)
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

### Engine auto-start (important)

**Restarting DSH takes the engine process down with it.** Measured: two restarts, two dead engines, and the symptom is simply "the voice went silent". The plugin only speaks; it does not own the engine, so the engine has to outlive DSH.

Three layers are installed:

| Layer | Path | Role |
|---|---|---|
| Launcher | `$DSH_HOME/gpt-sovits/start-engine.bat` | Idempotent: skips when the port already answers, otherwise starts `api_v2.py` and waits for readiness |
| Hidden wrapper | `$DSH_HOME/gpt-sovits/run-hidden.vbs` | Runs it without a console window |
| Logon shortcut | Startup folder entry `GPT-SoVITS 语音引擎.lnk` | Runs the two above at logon |

- **Configuration follows the settings**: the launcher reads the port (`serverUrl`) and optional `engineRoot`) from `settings.json`, so changing the engine URL in the settings page moves the auto-start with it.
- **Diagnostic log**: `$DSH_HOME/gpt-sovits/engine-start.log` records each decision and its timing; a healthy start shows `ready after N checks`.
- **To opt out**: delete the shortcut from the Startup folder.
- `schtasks` (a scheduled task) needs administrator rights and returned `Access is denied`, which is why this uses the Startup folder instead.

> **Two `cmd` traps, both hit for real:**
> 1. **A batch file must stay ASCII.** `cmd.exe` parses `.bat` in the console code page, so non-ASCII comments get executed as commands (observed: `'独立于' is not recognized as an internal or external command`). `start-engine.bat` is therefore pure ASCII and the Chinese notes live in this README.
> 2. **Do not use `timeout` as a delay.** With redirected input `timeout.exe` reports `Input redirection is not supported` and exits immediately, which burned all 60 readiness polls in about two seconds and misreported a successful start as a timeout. Use `ping -n N 127.0.0.1 >nul` instead.

### Auto-read starts from the *next* reply

After switching on the composer's speaker (or "Auto-read new replies" in the settings page), **the reply already on screen is not read** — the toggle is about *new* replies, not "read this one now".

To confirm it works: leave the toggle on and send another message; the new reply speaks as soon as it lands.

### Traps only a real machine exposes (all fixed)

These are not speculation — they were measured from diagnostic logs. Each one maps to a symptom that looks like "everything is fine, it just doesn't speak":

| # | Trap | Symptom | Fix |
|---|---|---|---|
| 1 | `turnTail` is a list slot, **rendered once per turn**, so N drivers raced for one single-channel player | Speaks sometimes | **Module-level claim set**: whichever copy sees a reply first owns it |
| 2 | A **per-instance** `armed` flag deciding "auto-read just switched on" | N copies could not see each other → **all of them only recorded, none spoke** | Gate on the **persisted "last read" mark** (globally shared) |
| 3 | A component **returned before calling a hook** (`if (typeof turn !== "number") return null` ahead of `useChat(...)`) | Broke the rules of hooks → React threw → **the error boundary silently unmounted it** → button and driver **did not exist at all** | Every hook runs unconditionally, plus a **static assertion** forbidding an early return before the first hook |
| 4 | `turnTail`'s `turn` prop **measured as an `object`, not a number** | The type test always held → the driver never worked | **Stop depending on that prop**; coordinate through the claim set |
| 5 | Diagnostic probes with **no throttling**, one HTTP request per render | Thousands of log lines and synchronous disk writes per page load | Deduplicate per event name and report once per copy |
| 6 | The engine was tied to DSH's lifetime | **Silent every time DSH restarted** | The three auto-start layers above |

Regression coverage: a fake store, fake React effects and a fake `Audio` verify "3 drivers mounted, **exactly 1** speaks", "silent while switched off" and "an existing reply is not re-read".

### State directory and what needs a reload

| Topic | Note |
|---|---|
| Default state location | `$DSH_HOME/gpt-sovits`; falls back to `~/.dsh/gpt-sovits` when the host process cannot see `DSH_HOME` |
| Host-half edits | `dsh-gpt-sovits` is a `file:` dependency, and pnpm **copies** rather than links it, so editing the workspace does not affect the installed copy. Re-sync by overwriting `~/.dsh/profiles/desktop/node_modules/dsh-gpt-sovits/`, or `remove` then `add` |
| When the client half appears | The client bundle is composed into the boot graph: **refresh the page** |
| When the host half reloads | Installation mounts the plugin immediately (routes answer at once), but already-loaded module code **does not hot-reload** — code changes need a DSH restart |

### Known limitations

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
> Every row was measured on the machine; the **42 offline checks** and the **12 live-engine integration checks** both passed there, and the button and auto-read were confirmed by the author clicking them on this same machine.
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
| Plugin version | v0.1.0 |

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
