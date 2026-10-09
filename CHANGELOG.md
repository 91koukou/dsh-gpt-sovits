# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.2] — 2026-10-04

Four reliability fixes, all of them found by reading a diagnostic log rather than by guessing. They
share one shape: something the design said was bounded was not, or a contract was written down and
never implemented.

### Fixed

- **A deliberate cancellation was reported as a playback failure.** `stop()` aborts a loading clip on
  purpose by clearing `audio.src`, and `audio.onerror` rejected unconditionally — so a cancelled clip
  looked like a broken one. Measured: 36 of 53 `audio playback failed` reports followed a `turn-reset`
  within two seconds, one of them 17 ms after the click. A failed load is now checked against the
  generation first, and resolves quietly when the player was the one who asked for it to stop.

- **The retry the host promised was never written.** `handleAudio` answers `clip-missing` for an
  evicted clip and its comment states that the client re-requests it; the client contained zero
  occurrences of `clip-missing`. Clips have been memory-only since 0.3.0, so a URL really does die with
  the host or with eviction. A lost clip is now re-synthesized once, and `clipErrorName(url)` asks the
  host to name a load failure instead of guessing from a numeric `MediaError`.

- **One turn was reset eight times.** Every mounted driver copy sees the turn number advance relative
  to its own last render, so all of them ran `stop()` and `CLAIMED.clear()` for the same turn — 1,005
  of them in one log. The duplication was not harmless: each copy's `stop()` aborted the clip a sibling
  had just started, which is where most of the reports above came from. The claim now lives at module
  scope (a remount resets a `useRef`) and is taken **before** the work, so a copy that loses the race
  never reaches the player. A fresh mount adopts an existing claim; a conversation switch drops it,
  because `turnOrder` is a workspace-wide count.

- **A clip that never settles deadlocked the queue.** `drain()` awaits `playClip`, and `draining` is
  only cleared in `finally`, so a promise that never settled stopped the queue until the page was
  reloaded. A loose 180-second watchdog guarantees settlement, armed only after `play()` resolves so a
  cancelled clip leaves no timer behind.

### Changed

- **The diagnostics were bounded.** Every report was pushed into a module-level array that production
  code never read (~1 MB per session), `{once:true}` never matched the id-bearing names
  (`see-<messageId>`, `gate-<messageId>`), and `diag.log` had no size check at all. The array is gone,
  every id-bearing name is reduced to its family before deduplicating, `diag.log` rolls over to
  `diag.log.1` past 2 MB, and `trimCache` gained a 512-entry ceiling. Measured: 200 simulated reports
  with distinct ids now grow the set and the POST count by 2 each.

- **Documentation was split.** The root [README.md](./README.md) is now project name, introduction,
  core features, quick start and licence; the former full READMEs moved to
  [docs/README.zh.md](./docs/README.zh.md) and [docs/README.en.md](./docs/README.en.md), which keep
  every section they had and gained appendix 19 describing this release.

### Removed

- A duplicated doc comment ("One sentence per request while streaming…") and `drain(words)`'s dead
  parameter, which was declared and threaded through the recursive call but never read.

### Tests

61 offline checks (up from 58). The three new ones cover the diagnostics ceilings in memory and on
disk, a cancellation resolving quietly with a lost clip re-requested exactly once, and the turn claim
being module-level, adopted by a remount and dropped by a restart.

---

## [0.3.1] — 2026-10-04

### Fixed

- **Switching conversation now actually stops the voice.** Reported as "it still
  reads the previous conversation after I switch". 0.3.0 looked correct and did
  nothing, because the previous session id was kept in the driver component's
  `useRef` — and a session-scoped slot is rendered under a **per-session React
  key** (`sessionGenerationKeyOf` in `@deepseek-ai/dsh-client-ui-renderer`), so a
  switch unmounts the subtree and mounts a fresh copy whose refs are all `null`
  again. Every mount re-entered the "first mount, nothing to report" branch, and
  the restart never ran. The log settled it: 50 `driver-mounted`, zero
  `conversation-changed`, while the module-level player kept speaking for a
  component that no longer existed.

  The previous value now lives at **module scope** (`LAST_DRIVER_SESSION`), the
  only storage that survives the remount, and the new session is claimed before
  the restart so N mounted copies do not each report the same switch.

- **An unmounted driver releases its audio.** The player is module-level, so it
  outlives the component. `driver` unmount now calls `stop()` *and* pauses the
  element, drops its `src` and clears the reference — a paused element that is
  still referenced keeps holding the output. This is the second, independent
  guard: even if the shell ever stops remounting on a switch, the teardown
  silences playback on its own.

### Changed

- The four dead switch detectors are gone for good (`selectSessionKey` over five
  guessed store fields, `navigation.current` turn continuity, the node-set
  digest, the page URL) together with the DOM `MutationObserver` fallback. None
  of them could see a switch; the slot catalog's `sessionId` standard prop could
  all along.

- Two offline self-checks were rewritten and two more added, all inside the
  existing session-switch check, so the total stays at **58**. One rejects a
  component-local previous-session value from coming back; the other renders a
  real driver, runs the cleanup it registered, and requires the audio element to
  be released. Two more drive the fix end to end: a switch **across a remount**
  (same module state, fresh refs) must empty the queue and advance the epoch, and
  the first mount must not restart anything. The self-check harness can now
  reproduce a remount (fresh ref cells) and collect effect cleanups, which is
  what those need.

### Documentation

The release first went out with only the Chinese README updated, so the English one still described
the detector this version deletes — it named `selectSessionKey` and a `MutationObserver` fallback,
neither of which exists any more. The two are level again, and the other two slips are corrected:

- **`README.en.md` brought to parity with `README.md`**: the version row and a `v0.3.1` entry in the
  version table; the feature line for a conversation switch, which still claimed the identity was
  "tracked separately, with a transcript-shape fallback"; and section 15 rewritten to match the
  Chinese text — the signal is the standard `sessionId` prop, the previous value has to live at
  module scope because a switch unmounts and remounts the session-scoped subtree under a per-session
  React key, the new session is claimed before the restart so the several copies of a list slot do
  not each report it, and an unmounting driver releases its audio element because a
  paused-but-referenced one keeps holding the output.
- **This entry's date**, 2026-10-04, the day it was actually released.
- **The Chinese README's version row**, which had been left at v0.3.0 while its own version table
  already listed v0.3.1.

Both READMEs carry 18 matching appendix sections again. No code changed for any of it.

---

## [0.3.0] — 2026-10-03

Six items, all reported from listening to the output. The theme is that the
*rhythm* of speech was being decided by the engine rather than by the plugin:
a sentence's own punctuation is the only thing that should say how long the pause
after it is.

### Added

- **Per-sentence expression.** Speed, `temperature`, `top-k` and `top-p` are now
  sent with every request, so a reading session can change pace or tone partway
  through instead of committing at synthesis time. Adjustment is per-sentence by
  design: a change applies from the next sentence, and nothing already spoken is
  redone. Volume stays a playback property — it costs nothing to change and never
  invalidates a synthesis.
  - **Generation quality is deliberately excluded.** `sample_steps` and
    `super_sampling` describe how much work the engine does, not how the voice
    sounds; letting them differ per sentence would change fidelity halfway
    through one answer.
  - Measured on the real engine: `speed_factor = 1.3` shortened the same sentence
    from 189484 B to 145964 B, and `temperature` at 0.3 and 1.5 produced different
    lengths again — all four controls reach the engine.
- **Pauses measured from the sentence's own punctuation**, with the engine's
  trailing silence trimmed away: a full stop pauses, a comma barely does, a
  paragraph break clearly longer, an ellipsis longest.
- **The on-disk clip cache is reclaimed** on the first boot after upgrading, since
  audio no longer touches the disk.

### Changed

- **Audio never touches the disk again.** Every clip used to be written to
  `$DSH_HOME/gpt-sovits/audio/` and served as a static file — one small write per
  sentence, for data played once and never read again. Clips now live in memory and
  are served straight from the host, capped by both count and total bytes so a run
  of long summaries cannot grow without bound.
- **The engine is told to add no silence of its own** (`fragment_interval: 0`, was
  the engine's default 0.3 s). That default was the real source of the long,
  uneven gaps: a packed block handed over with `cut5` was still split inside the
  engine, and every internal boundary added 0.3 s of its own.
- **Sentence splitting no longer depends on the full stop alone.** Chinese has more
  sentence terminators and they arrive in runs:
  - `。！？；…` and their ASCII forms all end a sentence, as do runs of them
    (`！？`, `……`) — splitting on those with a lookbehind produced
    `他沉默了三秒…` plus a lone `…`, which the engine then spoke separately.
  - A closing quote or bracket ends the sentence with the mark inside it:
    `他说：“走吧。”` is one sentence, not one and a half.
  - **A paragraph break is a hard boundary** and gets the longest pause. The
    cleaning chain used to collapse every run of newlines into one, so a paragraph
    was indistinguishable from a soft line wrap and the reader ran one thought into
    the next.
  - Merging short sentences is now deliberately rare. It caused "sentences that
    should not be joined get joined", because merged text reaches the engine as one
    request and the boundary between them is then outside the plugin's control.
    Only a true fragment (≤10 characters) with no strong pause pending is merged.

### Fixed

- **Tables were read as minus signs.** Reported. A reply reaches this pipeline as raw
  markdown, so a table arrived as pipes and dashes and the engine reads both aloud:
  `| --- | --- |` became a run of "竖线 减号 减号 减号". Neither character is content — one is
  a cell boundary, the other is how the format draws a line. The separator row is now dropped
  entirely and the cells are joined with a comma, which the sentence splitter then treats as a
  weak pause, so a row reads as a list of values.
- **A referenced symbol was not spoken at all.** Reported. ``把 `;` 也作为切分符号`` lost the
  semicolon: the engine drops a bare `;`, so the sentence was about a symbol it never said.
  A symbol inside backticks is now spoken **by name** — 分号, 逗号, 句号, 左方括号 — while
  punctuation *used* as punctuation keeps behaving as one. A code identifier is untouched:
  `\`split\`` stays "split", because naming every character of a word would be nonsense.
  - The name is masked and restored at the end, like a URL. That is not cosmetic: substituting
    plain Chinese early would make a referenced `。` read as the word 句号 *and then act as a
    sentence terminator*, splitting the sentence in the wrong place.
- **The slash rule destroyed every rate and speed unit.** Reported: the generic rule reads
  every slash as "或", which is right for `是/否` and wrong for a unit, where the slash means
  "per". `120km/h` came out as `120km或h`, `3000r/min` as `3000r或min`, `100MB/s` as
  `100MB或s` — the unit was gone and the sentence was nonsense.
  - Fixed with a **unit table**, not cleverer pattern matching: the set of units is
    open-ended, and a reader can extend a table while a regex encoding the same knowledge
    would be unreadable. Compound units are rewritten **before** the slash rule.
  - **Bare abbreviations are expanded too**, because a stray Latin abbreviation reaches the
    engine as spelling: `2.4GHz` was read "2点4 G H z". Now 吉赫兹, 毫秒, 吉字节, and so on.
    This runs *after* the file-extension rule, so `a.b.js` is still an extension, and it
    requires a digit in front, so the `min` in "minimum" and the `s` in "things" are left
    alone.
  - Spacing inside a unit is accepted (`100 km / h`), and the quantity is consumed with the
    unit — matching the unit alone re-emitted the number and read "120 120千米每小时".
- **Switching workspace or session left the previous conversation being read**, and
  every further switch appended to the same queue, so the queue grew without bound.
  The turn counter cannot see this — another conversation is not a turn of this one
  — so the conversation identity is tracked separately, with a transcript-shape
  fallback for a build whose store exposes no session key.
- **Sentences were joined that should have stayed apart** (see *Changed*).
- **A sentence beginning with punctuation produced an empty first utterance**, which
  the engine logged as `实际输入的目标文本: 。你好…` and synthesized as a stray pause.

---

## [0.2.0] — 2026-10-03

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
