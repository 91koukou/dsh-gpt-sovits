# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] — unreleased

Everything below was measured on a real machine and driven by reported symptoms,
not guessed at. Each entry names the symptom that caused it, because several of
these bugs looked like "everything is fine, it just does not speak".

### Added

- **Startup greeting.** A real synthesis of 「你好，欢迎回来」 that plays once per
  DSH session. It serves two purposes: it proves the whole chain works (plugin →
  engine → weights → reference clip), and it pays the cold start — GPT-SoVITS
  loads weights, BERT and CNHuBERT on the first `/tts`, so the user's first real
  sentence is already fast. Configurable and switchable (`greetOnStart`,
  `greetText`).
- **Engine console inside the settings page.** The engine's stdout/stderr, the
  supervisor's decisions and the transcript of what was generated, with 1.5 s /
  0.5 s / manual refresh. This is the content of the API console window, without
  a window that steals focus and kills the engine when closed.
- **Live status panel**, powered by a new `?action=status` route: engine
  reachability, whether the engine is generating, greeting state, active voice
  and reference-clip presence, loaded weights, and the last syntheses with timing.
- **Per-request split control.** The client chooses `cut0` or `cut5` per request;
  an unspecified request defaults to `cut0`, because an unexpected split is what
  produced truncation in the first place.
- **Symbol-to-speech rewriting**: `cmd.exe` → 「cmd点exe」, `3-10` → 「3到10」,
  `v2.7.0` → 「v2点7点0」, `36.5` → 「36点5」, `127.0.0.1` → 「127点0点0点1」,
  `是/否` → 「是或否」, `3/4` → 「4分之3」, `C:\Users` → 「C:杠Users」. Dates such
  as `2024-10-03` are preserved rather than read as a range.
- **Prefetch pipeline** (`PREFETCH_AHEAD = 2`): clips are synthesized while the
  current one plays, which is the only parallelism available — `api_v2.py` is a
  GIL-bound Python process and one synthesis cannot be parallelized internally.
- **Engine lifecycle bound to DSH**, via a Python supervisor that runs without a
  console window. The engine starts and stops with DSH, and an orphan left by a
  crash is reaped on the next boot.

### Changed

- **Auto-read queues instead of preempting.** Streaming text is now spoken one
  sentence at a time, in order, with each sentence queued exactly once as the
  reply grows.
- **Streaming and the final summary use different strategies.** Streaming text
  goes one sentence per request with `cut0` so audio starts as early as possible;
  a settled summary is packed into blocks with `cut5` so the engine cuts inside a
  block rather than paying one request per sentence. Measured: the same four
  sentences take one request and 1.6 s packed, versus four requests and roughly
  3.4 s one at a time.
- **The engine is no longer assumed to outlive DSH.** The reverse is now true, so
  the scheduled task and Startup-folder shortcut were removed: they kept
  resurrecting the engine and fought the new lifecycle.

### Fixed

- **Audio cut off mid-sentence, or a sentence never spoken.** Two splitters were
  disagreeing: the client packed sentences into a ~110-character buffer while the
  engine re-split each request with `cut5`. Measured in the log, `speak` was
  followed four milliseconds later by `play-failed` on the previous message —
  four utterances out of five were being cut off.
- **Engine console mojibake** (reported). Python on Windows encodes stdout/stderr
  with the console code page (cp936 here) while the panel decoded UTF-8, so every
  Chinese line was garbled — including the socket errors and the target text,
  which is exactly what a reader needs. The supervisor now sets
  `PYTHONIOENCODING=utf-8`, and the reader re-decodes a log left by an older
  supervisor instead of displaying it wrong.
- **The greeting never played.** Three separate causes, each fixed: a fixed 1.5 s
  delay fired ~19 s before the engine had bound its port; a failure left the
  in-flight latch set, so the state stayed `synthesizing` forever with no retry;
  and wrapping `speak` in `withEngine` deadlocked the serial engine queue, which
  reported `busy` for over 60 s with no progress.
- **A transient boot failure silenced the greeting for the whole session.**
- **`greeting.state` reported `idle` while the greeting was synthesizing.**
- **Leaving the settings page stopped playback.** The panel's unmount handler
  called `player.stop()` unconditionally, which is how the greeting kept
  disappearing when the settings page was opened and closed.
- **Audio playing under "engine idle" status**, because the greeting synthesized
  outside the engine queue.
- **The greeting no longer competes with real work**: it is produced only when
  the engine is idle and stands down the moment the engine becomes busy, checked
  every 100 ms from local state so the check costs nothing.
- **Console window flicker on every cold start** (reported). The batch launcher
  used `ping` as its delay and `ping.exe` is a console program, so a cold start
  flashed 30–45 windows. The supervisor is one windowless process and its
  readiness wait is a socket connect.
- **A log-destroying bug in the supervisor**: `tasklist` text matching reported a
  live process as dead, so the supervisor exited immediately after starting the
  engine and left it unmanaged. Replaced with `OpenProcess` + `GetExitCodeProcess`.
  Likewise `netstat` parsing returned an empty set for a live listener, breaking
  adoption of an already-running engine; replaced with `GetExtendedTcpTable`.
- **Engine liveness was decided through a system proxy.** A proxy registered in
  the Windows registry answered `urlopen('http://127.0.0.1:9880/control')` with
  404 while nothing was listening on the port. Both the supervisor and the plugin
  now bypass proxies for loopback.
- **A growing reply replayed its opening sentences**, because the de-duplication
  mark treated a streamed reply as already spoken after its first fragment.
- **Toolchain fixes**: `catch` blocks that let a failed greeting render as a
  broken plugin; a `waitForEngine` call placed before its own declaration inside a
  temporal dead zone; and a `drain()` that referenced a loop-scoped binding from
  its `finally` block.

### Known limitations

- The Windows drive-letter scan for auto-discovery is read-only but touches every
  drive root; setting the checkout directory avoids it entirely.
- `3/4` is always read as a fraction. A genuine ratio cannot be told apart from a
  fraction, so write it out in the source text when the other reading is wanted.
- A different OS, DSH version or GPU is plausible but untested.

---

## [0.1.0] — 2026-10-02

First version. Per-reply read-aloud button, auto-read toggle, voice presets and a
settings page, driving a local GPT-SoVITS `api_v2.py`.
