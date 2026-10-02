# Third-party notices

`dsh-gpt-sovits` is MIT-licensed (see [LICENSE](./LICENSE)). This file records the
third-party code, constants and interface contracts it **actually** draws on, with
the exact locations, so the credit is where it belongs.

Every project below is MIT-licensed, which permits this reuse provided the notice
and permission text travel with the distribution. Nothing here is a claim about
projects that were only *read for reference* — those are listed separately at the
end, uncredited-but-acknowledged.

---

## 1. `MaRi23333/dsh-fish-tts` — text pipeline

- **Source**: https://github.com/MaRi23333/dsh-fish-tts (`dsh-fish-tts@0.2.11`)
- **License**: MIT — “Copyright (c) 2026 dsh-fish-tts contributors”
- **Where it went**: `lib/client.js`, function `cleanForSpeech`, and the
  single-object `WORDS` replacement table that feeds it.

The speech-cleaning regular-expression chain is **adapted directly** from that
project's `cleanForTts` (`lib/client.js`). Copied verbatim, character for character:

| Pattern | Purpose |
|---|---|
| `/https?:\/\/[^\s<>"|]+/g` | collapse URLs |
| `/[A-Za-z]:\\[^\s<>"|]+/g` | collapse Windows paths |
| `/(^\|[\s(（])(?:~\/\|\.{0,2}\/)[^\s<>"|]+/g` | collapse POSIX paths |
| `/\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/g` | collapse UUIDs |
| `/\b[0-9a-fA-F]{16,}\b/g` | collapse long hex |
| `/```[\s\S]*?```/g` | drop code fences |
| `/`([^`\n]+)`/g` | unwrap inline code |
| `/!\[[^\]]*\]\([^)]*\)/g` | drop images |
| `/\[([^\]]+)\]\([^)]*\)/g` | unwrap links |
| `/<[^>]+>/g` | strip HTML tags |
| `/(\*\*\|__\|~~\|\*\|_)(?=\S)(.*?)(?<=\S)\1/g` | unwrap emphasis |
| `/[ \t]+/g` | collapse runs of spaces |
| `/\n{2,}/g` | collapse blank lines |

**Deliberate local changes** (not from upstream): the long-identifier threshold is
`{28,}` rather than `{24,}`; the code-fence pattern gained an `|$` alternative so an
unterminated fence still matches; the emphasis pattern uses `[\s\S]*?` instead of
`.*?` so it can span lines; heading/blockquote/list-marker/rule stripping
(`/^\s{0,3}#{1,6}\s+/gm` and friends) was added here; and the replacement words are
a `{ zh, en }` table rather than upstream's `REPL_ZH` / `REPL_EN` pair.

Also adapted from the same file: the `window.__ModuleLoader__.load({ id, factory })`
client-bundle shape and the use of `require("react")` +
`require("react/jsx-runtime")` as the only module-table specifiers.

---

## 2. `fangqian616/dsh-say` — GPT-SoVITS engine contract

- **Source**: https://github.com/fangqian616/dsh-say (`dsh-say@0.1.0`)
- **License**: MIT — “Copyright (c) 2026 dsh-say contributors”
- **Where it went**: `lib/index.js` — the `/tts` payload and the liveness probe.

That project's `lib/engines/gptsovits.js` was read in full and used as the
specification for how to drive `api_v2.py`:

| Item | Value taken |
|---|---|
| Endpoint | `POST {serverUrl}/tts`, JSON body, raw WAV bytes back |
| Payload fields and defaults | `text_lang`, `ref_audio_path`, `prompt_text`, `prompt_lang`, `top_k: 15`, `top_p: 1`, `temperature: 1`, `text_split_method: "cut5"`, `batch_size: 1`, `speed_factor`, `seed: -1`, `media_type: "wav"`, `streaming_mode: false`, `parallel_infer: true`, `repetition_penalty: 1.35`, `sample_steps`, `super_sampling: false` |
| Liveness probe | `GET {serverUrl}/control`, where **an HTTP error counts as alive** — the endpoint returns 400 by design without a `command` |
| Default endpoint | `http://127.0.0.1:9880` |
| Sample-steps guidance | 32 is the default; lowering it is the documented speedup |

The endpoint contract itself originates upstream in
[RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) `api_v2.py`
(MIT); this plugin's `/set_gpt_weights` and `/set_sovits_weights` handling was
written against that file directly, including the fact that both are **GET-only**
and that an empty path answers 400.

---

## 3. DeepSeek Harness client plugins — slot and styling contract

- **Source**: the `@deepseek-ai/dsh-client-*` packages bundled inside the DSH app
  (`app.asar`), read at runtime on the machine this was developed on.
- **License**: MIT (`@deepseek-ai/dsh-client-ui-primitives` declares MIT;
  the packages are not published standalone, so no `LICENSE` file ships with them).
- **Where it went**: `lib/client.js` — the registration pattern and the button geometry.

Read as the authoritative API reference and adapted:

| From | Taken |
|---|---|
| `dsh-experimental-client-ui-voice-input/lib/client.js` | the `ctx.slots.inject(name, () => ctx.slots.register({ name, locale, inject }, Component))` pattern, `exports.apply` / `exports.inject`, and the `apply(ctx)` entry point |
| `dsh-client-ui-message-feedback/lib/client.js` | the `settings.section` registration shape (`{ name, id, order, label, locale }`), and the injected-stylesheet pattern — creating a `<style>` element tagged `data-plugin` / `data-plugin-css` and appending it to `document.head` |
| `dsh-client-ui-message-feedback/lib/client.js` (compiled CSS) | the action-button geometry mirrored by this plugin: `width/height: calc(28px + var(--dsh-content-font-delta,0px))`, `padding: 6px`, `border-radius: var(--dsw-radius-sm)`, `border: none`, `background: 0 0`, `display: inline-flex`, and the `svg { width/height: 15px }` rule |
| `dsh-client-ui-chat/lib/client.js` | the icon contract followed by the locally drawn glyphs (`size = 16`, `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth: 1` — upstream's `ICON_REGULAR_STROKE`), and the knowledge that `conversation.chat.turnTail` is handed an opaque `turn` |
| `dsh-client-ui-conversation/lib/client.js` (compiled CSS) | the composer row rule quoted in the README (`flex-wrap: wrap; justify-content: space-between; gap: 12px; …`) and the `conversation.input.left` 28px trigger geometry |
| `dsh-client-ui-chat/message-feedback` icons | the *decision* to draw the speaker and pause glyphs locally, after establishing that the shell's 377-icon set contains no speaker/volume/sound glyph |

The store reader (`snapshotNodes` and friends) reads `snapshot.nodes.values()`
because the shell's own `ApprovalCommand` in `dsh-client-ui-chat` reads the store
that way — that single line is what corrected four earlier wrong guesses.

No source file was copied; what is reused is the interface contract and a handful
of layout constants that exist to make a plugin look native.

---

## 4. `MeteorNOX/DeepSeek-Balance-Whale-Widget` — state-directory convention

- **Source**: https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
  (`dsh-whale-widget@0.3.17`), installed locally
- **License**: MIT
- **Where it went**: `lib/index.js`, `defaultStateDir()`

`const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')` — the
same two-step resolution. This plugin originally fell back to `process.cwd()`,
which silently wrote state into the profile directory because the DSH desktop app
does not export `DSH_HOME` to itself; the whale widget's line is what showed the
correct fallback. The helper was re-expressed, not copied verbatim.

---

## 5. Read for reference, not reused

- [`TaoruiLiu19/dsh-gsv-tts`](https://github.com/TaoruiLiu19/dsh-gsv) (MIT) — read for its overall architecture. This plugin's host/client split, weight-pair presets and settings layout were arrived at independently, but that project demonstrated the shape was viable. No code copied.
- [`maoyuching/dsh-voice-chat`](https://github.com/maoyuching/dsh-voice-chat) (MIT) — read for its route surface and settings-fallback ordering. No code copied.
- [`haide-D/SillyTavern-EchoCore`](https://github.com/haide-D/SillyTavern-EchoCore) (MIT) — read for its progressive paragraph relay. This plugin's per-sentence chunking was written independently before reading it. No code copied.
- [`RVC-Boss/GPT-SoVITS`](https://github.com/RVC-Boss/GPT-SoVITS) (MIT) — `api_v2.py` read directly for the endpoint contract, the closed `media_type` set and the GET-only weight setters. Not redistributed here.

---

## 6. Bundled third-party code

The plugin's only runtime dependency is **`@deepseek-ai/schemastery`**
(MIT, © DeepSeek), used by the host half to declare its configuration schema. It
is installed from the registry rather than vendored, and its own license applies.

Everything else in `lib/` is written for this project — except the text-cleaning
pattern chain credited in section 1.
