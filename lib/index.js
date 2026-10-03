/**
 * dsh-gpt-sovits — host half.
 *
 * Owns everything the browser cannot: talking to the GPT-SoVITS HTTP API,
 * persisting settings, bounding synthesis concurrency, and serving synthesized
 * audio back as a same-origin URL so the reply text never carries audio bytes.
 *
 * Routes (all loopback-only):
 *   GET  /gpt-sovits/api?action=settings   read effective settings
 *   POST /gpt-sovits/api?action=settings   persist a settings patch
 *   POST /gpt-sovits/api?action=synthesize synthesize one text, return {url,...}
 *   GET  /gpt-sovits/api?action=health     probe the engine
 *   GET  /gpt-sovits/audio/<id>.wav        play back a synthesized clip
 *
 * @module dsh-gpt-sovits
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

export const name = 'gpt-sovits'

/** Settings echoed to the client; the client never sees anything else. */
const MAX_TEXT_CHARS = 4000
const AUDIO_CACHE_LIMIT = 240
/**
 * Hard ceiling on the in-memory clip cache, in bytes.
 *
 * The clips are WAV, roughly 0.2-0.5 MB for a sentence, so this is about 100-200
 * sentences -- far more than a reading session needs, while keeping the plugin's footprint
 * predictable. A cap on the count alone would let a handful of long summaries grow without
 * bound.
 */
const AUDIO_CACHE_BYTES = 64 * 1024 * 1024
const DEFAULT_SERVER_URL = 'http://127.0.0.1:9880'
/** Spoken once when the plugin starts, so "the engine is ready" is audible. */
const DEFAULT_GREETING = '你好，欢迎回来'
const ROUTE_PREFIX = '/gpt-sovits'

/** GPT-SoVITS language tags accepted by `api_v2.py`'s `tts_config.languages`. */
const LANGUAGES = ['zh', 'en', 'ja', 'ko', 'yue', 'auto', 'all_zh', 'all_ja', 'all_ko', 'all_yue']

/**
 * Plugin configuration.
 *
 * Every field is optional with a working default: the plugin is usable the
 * moment it is installed, pointed at a default GPT-SoVITS API on 9880.
 */
export const Config = Schema.object({
  serverUrl: Schema.string().default(DEFAULT_SERVER_URL).description('GPT-SoVITS api_v2.py 地址'),
  engineRoot: Schema.string().default('').description('GPT-SoVITS 检出目录；用于自动发现模型权重（留空自动搜索）'),
  stateDir: Schema.string().default('').description('设置与音频落盘目录，默认 $DSH_HOME/gpt-sovits'),
  defaultVoice: Schema.string().default('').description('默认音色名（对应音色预设的 name）'),
  textLang: Schema.string().default('zh').description('朗读文本语言'),
  speed: Schema.number().default(1).description('语速倍率 0.5–2.0'),
  sampleSteps: Schema.number().default(32).description('采样步数；调低可明显加速'),
  timeoutMs: Schema.number().default(300000).description('单次合成超时（毫秒）'),
  greetOnStart: Schema.boolean().default(true).description('启动后朗读一句问候，表示引擎已就绪'),
  greetText: Schema.string().default(DEFAULT_GREETING).description('启动问候语；只在 greetOnStart 打开时朗读'),
  voices: Schema.array(
    Schema.object({
      name: Schema.string().required(),
      /** GPT (t2s) weights, a `.ckpt` under a `GPT_weights*` directory. Global engine state. */
      gptWeights: Schema.string().default(''),
      /** SoVITS (vits) weights, a `.pth` under a `SoVITS_weights*` directory. Global engine state. */
      sovitsWeights: Schema.string().default(''),
      /** Reference clip, sent per request. */
      refAudioPath: Schema.string().default(''),
      /** What that clip says; empty makes the engine transcribe it first. */
      promptText: Schema.string().default(''),
      promptLang: Schema.string().default('zh'),
    }),
  )
    .default([])
    .description('音色预设 = GPT 权重 + SoVITS 权重 + 参考音频 + 参考文本（GPT-SoVITS 原生三要素）'),
})

/**
 * Home-relative default for persisted state.
 *
 * `DSH_HOME` is set for the processes DSH spawns but not for the desktop app
 * itself, so the environment variable alone is not enough: without the
 * `$HOME/.dsh` fallback the state lands in whatever directory the app was
 * launched from (which is the profile directory under Electron), and the
 * documented `$DSH_HOME/gpt-sovits` path never appears.
 *
 * CREDIT: the two-step `DSH_HOME || ~/.dsh` resolution follows
 * `dsh-whale-widget` (https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget,
 * MIT), which resolves its own files the same way. See THIRD-PARTY-NOTICES.md.
 */
function defaultStateDir() {
  const configured = process.env.DSH_HOME
  const home = configured && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
  return join(home, 'gpt-sovits')
}

/**
 * An HTTP client for the engine that keeps loopback traffic off any proxy.
 *
 * Measured on the development machine: a system proxy registered in the Windows
 * registry answers on a local port, and `urllib` in the supervisor was fooled by
 * it -- `urlopen('http://127.0.0.1:9880/control')` came back 404 *from the proxy*
 * while nothing at all was listening on 9880. The engine is a loopback service
 * this plugin starts itself, so its requests must go straight there.
 *
 * Node 24 honours `NODE_USE_ENV_PROXY`. When that is on and a proxy is
 * configured, a loopback engine call would be sent to the proxy instead. This
 * forces the direct route by disabling proxying for these requests only, and
 * falls back to the plain global `fetch` when the option is unsupported.
 */
const ENGINE_FETCH_INIT = { proxy: false }

/** `fetch` an engine URL without any proxy involvement. */
const engineFetch = (url, init) => {
  try {
    return fetch(url, { ...init, ...ENGINE_FETCH_INIT })
  } catch {
    return fetch(url, init)
  }
}

/** Trim a trailing slash so `${base}/tts` never doubles up. */
function normalizeBase(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/** Clamp a number into a range, falling back when it is not finite. */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Refuse anything that is not the local browser.
 *
 * The engine can clone voices and the settings carry filesystem paths, so the
 * routes stay on loopback even when the host itself listens on 0.0.0.0.
 */
function guardLoopback(req, res) {
  const address = req.socket?.remoteAddress ?? ''
  const ok =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  if (!ok) {
    sendJson(res, 403, { ok: false, error: 'loopback-only' })
    return false
  }
  return true
}

/** Reject cross-site form posts while still allowing the GUI's own fetches. */
function guardOrigin(req, res) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  let host
  try {
    host = new URL(origin).hostname
  } catch {
    sendJson(res, 403, { ok: false, error: 'bad-origin' })
    return false
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return true
  sendJson(res, 403, { ok: false, error: 'cross-origin-forbidden' })
  return false
}

/** Read and parse a bounded JSON request body. */
async function readJsonBody(req, limitBytes = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** A short, stable digest — used for cache keys and clip ids. */
function digest(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 24)
}

/**
 * Clean a user-entered path.
 *
 * Windows' "Copy as path" wraps the result in double quotes, and pasting that
 * straight in makes the engine treat the quotes as part of the filename, so it
 * fails to open the file and answers `tts failed` with no hint as to why.
 * Surrounding whitespace goes too: a pasted path often carries a trailing space.
 */
function cleanPath(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  // Repeat: a path pasted twice keeps accumulating quoting.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim()
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1).trim()
    if (text === before) break
  }
  return text
}

/**
 * Normalize one voice preset, dropping entries that cannot be spoken.
 *
 * A preset mirrors what GPT-SoVITS actually needs: the GPT (t2s) weights, the
 * SoVITS (vits) weights, the reference clip, and the transcript of that clip.
 * The two weight files are global engine state; the clip and transcript travel
 * with every request.
 */
function normalizeVoice(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const preset = raw
  const voiceName = typeof preset.name === 'string' ? preset.name.trim() : ''
  if (voiceName === '') return undefined
  const promptLang = typeof preset.promptLang === 'string' && LANGUAGES.includes(preset.promptLang) ? preset.promptLang : 'zh'
  return {
    name: voiceName,
    // Every path is cleaned: pasted quotes are the single most common way a
    // working engine still answers "tts failed".
    gptWeights: cleanPath(preset.gptWeights),
    sovitsWeights: cleanPath(preset.sovitsWeights),
    refAudioPath: cleanPath(preset.refAudioPath),
    promptText: typeof preset.promptText === 'string' ? preset.promptText.trim() : '',
    promptLang,
  }
}

/**
 * Resolve the config plus the persisted user file into one effective object.
 *
 * Precedence is user file > plugin config > built-in default, matching what the
 * settings page shows: whatever the user last saved wins.
 */
function effectiveSettings(config, userFile) {
  const persisted = userFile !== null && typeof userFile === 'object' ? userFile : {}
  const pick = (key, fallback) => {
    const value = persisted[key]
    if (value !== undefined && value !== null && value !== '') return value
    return fallback
  }
  const voicesSource = Array.isArray(persisted.voices)
    ? persisted.voices
    : Array.isArray(config.voices)
      ? config.voices
      : []
  return {
    serverUrl: normalizeBase(pick('serverUrl', config.serverUrl ?? DEFAULT_SERVER_URL)) || DEFAULT_SERVER_URL,
    engineRoot: String(pick('engineRoot', config.engineRoot ?? '')).trim(),
    defaultVoice: String(pick('defaultVoice', config.defaultVoice ?? '')),
    textLang: LANGUAGES.includes(pick('textLang', config.textLang)) ? pick('textLang', config.textLang) : 'zh',
    speed: clampNumber(pick('speed', config.speed ?? 1), 0.5, 2, 1),
    sampleSteps: Math.round(clampNumber(pick('sampleSteps', config.sampleSteps ?? 32), 4, 128, 32)),
    timeoutMs: Math.round(clampNumber(pick('timeoutMs', config.timeoutMs ?? 300000), 5000, 900000, 300000)),
    /*
     * Booleans and empty strings need their own handling: the shared `pick` treats
     * `''` as absent, which is right for a URL and wrong here — a greeting text the
     * user deliberately cleared would silently fall back to the default. For
     * `greetOnStart` the check is explicit so a stored `false` survives.
     */
    greetOnStart: typeof persisted.greetOnStart === 'boolean' ? persisted.greetOnStart : config.greetOnStart !== false,
    greetText: String(
      persisted.greetText !== undefined && persisted.greetText !== null
        ? persisted.greetText
        : config.greetText ?? DEFAULT_GREETING,
    ),
    voices: voicesSource.map(normalizeVoice).filter((voice) => voice !== undefined),
  }
}

/**
 * Candidate GPT-SoVITS checkout directories, most specific first.
 *
 * There is no single install location: the official Windows package is an
 * archive people unpack wherever there is room, often a secondary drive root.
 */
function engineRootCandidates(configured) {
  const candidates = []
  if (configured !== undefined && configured.trim() !== '') candidates.push(configured.trim())
  if (process.env.DSH_SOVITS_ENGINE_ROOT) candidates.push(process.env.DSH_SOVITS_ENGINE_ROOT)
  candidates.push(join(homedir(), 'GPT-SoVITS'), join(homedir(), 'GPT-SoVITS-main'), join(homedir(), 'gpt-sovits'))
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`
      let entries
      try {
        entries = readdirSync(drive, { withFileTypes: true })
      } catch {
        continue // no such drive, or not readable
      }
      for (const entry of entries) {
        if (entry.isDirectory() && /^gpt[-_]?sovits/i.test(entry.name)) candidates.push(join(drive, entry.name))
      }
    }
  }
  return candidates
}

/** True when a directory looks like a GPT-SoVITS checkout with weights. */
function looksLikeEngine(root) {
  try {
    return existsSync(join(root, 'api_v2.py')) && existsSync(join(root, 'GPT_SoVITS', 'pretrained_models'))
  } catch {
    return false
  }
}

/**
 * The runtime pieces needed to start the engine from a checkout directory.
 *
 * `pythonw.exe` is preferred on Windows: it is the GUI-subsystem build, so no
 * console is created even if the no-window creation flag were ignored. This is
 * what removes the console flicker a batch launcher produced.
 */
function launcherPaths(engineRoot) {
  if (engineRoot === '' || !looksLikeEngine(engineRoot)) return undefined
  const runtime = join(engineRoot, 'runtime')
  const candidates = process.platform === 'win32'
    ? [join(runtime, 'pythonw.exe'), join(runtime, 'python.exe')]
    : [join(runtime, 'bin', 'python3'), join(runtime, 'bin', 'python')]
  const python = candidates.find((candidate) => existsSync(candidate))
  if (python === undefined) return undefined
  const yaml = join(engineRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
  return {
    engineRoot,
    python,
    api: join(engineRoot, 'api_v2.py'),
    yaml: existsSync(yaml) ? yaml : '',
  }
}

/** Replace everything but the port in a server URL, for the supervisor's `--server`. */
function serverUrlFor(port) {
  return `http://127.0.0.1:${port}`
}

/**
 * List the model weights a checkout offers.
 *
 * Trained voices live in the `GPT_weights*` and `SoVITS_weights*` directories,
 * as `.ckpt` and `.pth` files, and both the directory suffix and the file stem
 * are the user's own naming. Listing them beats asking the user to type a path
 * that must be readable by the engine process.
 */
function listWeights(engineRoot) {
  const result = { engineRoot: '', gpt: [], sovits: [] }
  for (const root of engineRootCandidates(engineRoot)) {
    if (!looksLikeEngine(root)) continue
    result.engineRoot = root
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      break
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const isGpt = /^GPT_weights/i.test(entry.name)
      const isSovits = /^SoVITS_weights/i.test(entry.name)
      if (!isGpt && !isSovits) continue
      let files
      try {
        files = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        const wanted = isGpt ? /\.ckpt$/i : /\.pth$/i
        if (!wanted.test(file.name)) continue
        // Relative to the engine root: the engine resolves these against its own
        // working directory, and a relative path survives moving the checkout.
        const rel = `${entry.name}/${file.name}`
        const version = /^[A-Za-z]+_weights_?(.*)$/.exec(entry.name)
        const record = { path: rel, file: file.name, dir: entry.name, version: version && version[1] ? version[1] : '' }
        if (isGpt) result.gpt.push(record)
        else result.sovits.push(record)
      }
    }
    break
  }
  const byName = (left, right) => left.path.localeCompare(right.path, 'zh')
  result.gpt.sort(byName)
  result.sovits.sort(byName)
  return result
}

/**
 * Write the little batch fragment the engine launcher sources, and refresh the
 * supervisor script next to it.
 *
 * `start-engine.bat` runs outside the plugin and has no JSON parser, and `call`
 * cannot take a quoted path containing `-` (cmd reads it as a label, and 8.3
 * truncation mangles it), so the launcher's port and engine directory are
 * regenerated here every time settings are saved. That keeps the launcher
 * pointed at whatever engine the user last configured.
 *
 * The supervisor is copied in for the same reason: the manual launcher must run
 * the exact same component the plugin does, and it cannot rely on the plugin's
 * install path staying put.
 */
function writeLauncherDefaults(stateDir, effective, supervisorSource) {
  const portMatch = /:(\d+)\s*$/.exec(effective.serverUrl)
  const port = portMatch === null ? '9880' : portMatch[1]
  const lines = [
    '@echo off',
    'REM Generated by dsh-gpt-sovits on every settings save. Do not edit.',
    'if "%PORT%"=="" set "PORT=' + port + '"',
    'if "%ENGINE_ROOT%"=="" if not "' + effective.engineRoot + '"=="" set "ENGINE_ROOT=' + effective.engineRoot + '"',
  ]
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'settings.local.bat'), `${lines.join('\r\n')}\r\n`, 'ascii')
  } catch {
    // The launcher keeps its built-in default; not worth failing a save over.
  }
  if (supervisorSource !== undefined && existsSync(supervisorSource)) {
    try {
      copyFileSync(supervisorSource, join(stateDir, 'supervisor.py'))
    } catch {
      // Same: the launcher falls back to the copy inside the plugin directory.
    }
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - Host context; `webServer` provides the HTTP carrier.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const stateDir = String(config.stateDir ?? '').trim() === '' ? defaultStateDir() : resolve(String(config.stateDir))

  /**
   * The checkout discovery last resolved, remembered for the start path.
   *
   * Declared here, above every route handler that assigns it: a `let` used
   * before its declaration is a temporal-dead-zone error, and the settings page
   * can call the models route long before the code further down is reached.
   */
  let resolvedEngineRoot = ''
  /**
   * The directory an older version wrote clips into.
   *
   * Audio is memory-only now, so nothing writes here. The path is kept for the one-time
   * cleanup below, and recreated defensively because the supervisor and the settings file
   * still live in the same directory tree.
   */
  const audioDir = join(stateDir, 'audio')
  const settingsPath = join(stateDir, 'settings.json')
  const diagPath = join(stateDir, 'diag.log')

  const ensureDirs = () => {
    mkdirSync(stateDir, { recursive: true })
    return stateDir
  }
  ensureDirs()

  /**
   * Read the persisted settings file.
   *
   * A leading BOM is stripped first: several Windows tools (notably PowerShell's
   * `Set-Content -Encoding UTF8`) write one, and `JSON.parse` rejects it. Without
   * this the whole file silently degrades to defaults — the user's presets
   * vanish with no error anywhere.
   */
  const readUserFile = () => {
    try {
      const text = readFileSync(settingsPath, 'utf8')
      const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      const parsed = JSON.parse(trimmed)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeUserFile = (patch) => {
    const current = readUserFile()
    const next = { ...current }
    if (patch.serverUrl !== undefined) next.serverUrl = normalizeBase(patch.serverUrl)
    if (patch.engineRoot !== undefined) next.engineRoot = String(patch.engineRoot).trim()
    if (patch.defaultVoice !== undefined) next.defaultVoice = String(patch.defaultVoice)
    if (patch.textLang !== undefined && LANGUAGES.includes(patch.textLang)) next.textLang = patch.textLang
    if (patch.speed !== undefined) next.speed = clampNumber(patch.speed, 0.5, 2, 1)
    if (patch.sampleSteps !== undefined) next.sampleSteps = Math.round(clampNumber(patch.sampleSteps, 4, 128, 32))
    if (patch.timeoutMs !== undefined) next.timeoutMs = Math.round(clampNumber(patch.timeoutMs, 5000, 900000, 300000))
    if (patch.greetOnStart !== undefined) next.greetOnStart = patch.greetOnStart === true
    if (patch.greetText !== undefined) next.greetText = String(patch.greetText).slice(0, 200)
    if (Array.isArray(patch.voices)) next.voices = patch.voices.map(normalizeVoice).filter((voice) => voice !== undefined)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    // Keep the standalone engine launcher in step with the saved settings, and
    // hand it the supervisor so both start paths run the same component.
    writeLauncherDefaults(stateDir, effectiveSettings(config, next), join(import.meta.dirname, 'supervisor.py'))
    return next
  }

  const settings = () => effectiveSettings(config, readUserFile())

  /**
   * clipId -> { buffer, contentType, createdAt }
   *
   * **In memory, not on disk.** The previous version wrote every clip to
   * `$DSH_HOME/gpt-sovits/audio/` and served it as a static file, which meant a disk write
   * per sentence — on a long reading session that is hundreds of small writes for data
   * that is played once and never looked at again. The user asked for exactly this: keep
   * it in memory and stop wearing the drive.
   *
   * The cost is RAM, and it is bounded twice: only `AUDIO_CACHE_LIMIT` clips are held, and
   * `AUDIO_CACHE_BYTES` caps the total. Eviction is oldest-first, so the sentence being
   * spoken now is never dropped to make room for one being prefetched.
   */
  const audioCache = new Map()
  let audioCacheBytes = 0

  /** Drop the oldest entries until both ceilings are satisfied. */
  const evictAudio = () => {
    while (audioCache.size > AUDIO_CACHE_LIMIT || audioCacheBytes > AUDIO_CACHE_BYTES) {
      const oldest = audioCache.keys().next().value
      if (oldest === undefined) break
      const entry = audioCache.get(oldest)
      audioCache.delete(oldest)
      audioCacheBytes -= entry?.buffer?.byteLength ?? 0
    }
    if (audioCacheBytes < 0) audioCacheBytes = 0
  }

  /** Insert with FIFO and byte-count eviction; the browser holds the URL only to play it. */
  const rememberAudio = (clipId, entry) => {
    const existing = audioCache.get(clipId)
    if (existing !== undefined) audioCacheBytes -= existing.buffer?.byteLength ?? 0
    // Re-inserting moves the entry to the back of the FIFO order.
    audioCache.delete(clipId)
    audioCache.set(clipId, entry)
    audioCacheBytes += entry.buffer?.byteLength ?? 0
    evictAudio()
  }

  /**
   * Delete the on-disk clips an older version left behind.
   *
   * Runs once per boot, so an installation upgrading into the memory-only design does not
   * keep the old directory forever. Failures are ignored: this is housekeeping, and a
   * locked file must not stop the plugin from starting.
   */
  const purgeLegacyAudioFiles = () => {
    try {
      const dir = audioDir()
      if (!existsSync(dir)) return 0
      let removed = 0
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.wav')) continue
        try {
          rmSync(join(dir, name), { force: true })
          removed += 1
        } catch { /* in use or already gone */ }
      }
      return removed
    } catch {
      return 0
    }
  }

  /**
   * Probe the engine.
   *
   * `GET /control` without a `command` answers HTTP 400 by design, so a 400 is
   * a healthy signal here and only a transport failure means "not running".
   */
  const probeHealth = async (serverUrl) => {
    const base = normalizeBase(serverUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const response = await engineFetch(`${base}/control`, { signal: controller.signal })
      return { running: true, serverUrl: base, detail: `HTTP ${response.status}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { running: false, serverUrl: base, detail: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Weights the engine currently holds.
   *
   * Swapping weights reloads them from disk, so it is only done when a preset
   * actually names a different pair. `unknown` means "not yet touched by this
   * process": whatever `api_v2.py` loaded from its own startup yaml is in
   * effect, and the first synthesis with a preset that names weights must issue
   * the switch.
   */
  let activeGpt = 'unknown'
  let activeSovits = 'unknown'

  /**
   * Serialize weight switching and synthesis.
   *
   * `api_v2.py` runs with `workers=1` and its model state is global, so two
   * overlapping requests could interleave "set weights" with "synthesize" and
   * produce a clip in the wrong voice. Every engine-touching operation therefore
   * goes through this chain.
   */
  let engineQueue = Promise.resolve()
  /** How many engine operations are queued or running, for the status page. */
  let engineQueueDepth = 0
  /**
   * When the engine last became busy, and when it last went idle.
   *
   * Plain timestamps rather than a flag, because the greeting gate asks "is the engine
   * working right now?" every 100 ms. Reading two variables costs nothing; probing the
   * engine over HTTP ten times a second would compete with the synthesis it is trying to
   * observe.
   */
  let engineBusySince = 0
  let engineIdleSince = Date.now()
  /**
   * Engine reachability, cached.
   *
   * `probeHealth` is an HTTP round trip, so the greeting gate must not call it: the gate
   * runs on every client poll and must stay a variable read. The heartbeat refreshes
   * this on a slow tick. `undefined` means "not asked yet".
   */
  let healthCache
  const recentHealth = () => healthCache
  const engineQueueBusy = () => engineQueueDepth > 0
  const withEngine = (operation) => {
    engineQueueDepth += 1
    if (engineQueueDepth === 1) engineBusySince = Date.now()
    const release = () => {
      engineQueueDepth -= 1
      if (engineQueueDepth === 0) engineIdleSince = Date.now()
    }
    const run = engineQueue.then(operation, operation)
    // Keep the chain alive after a failure; the failure itself is reported to
    // the caller that caused it.
    engineQueue = run.then(
      () => release(),
      () => release(),
    )
    return run
  }

  /**
   * The last few syntheses, newest first, for the status page.
   *
   * Answers "is it actually generating, and what?", which is the question the
   * settings page could not answer before. Bounded so a long session cannot grow it
   * without limit.
   */
  const recentSynthesis = []
  const HISTORY_LIMIT = 20
  const rememberSynthesis = (entry) => {
    recentSynthesis.unshift(entry)
    if (recentSynthesis.length > HISTORY_LIMIT) recentSynthesis.length = HISTORY_LIMIT
  }

  /** Call one of the GET-only weight setters, which answer with a JSON message. */
  const callEngineGetter = async (serverUrl, path, params, signal) => {
    const url = new URL(`${serverUrl}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const timeout = AbortSignal.timeout(120000)
    const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await engineFetch(url, { signal: composite })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      let reason = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text)
        reason = String(parsed.message ?? parsed.Exception ?? reason)
      } catch {
        /* keep the raw body */
      }
      const error = new Error(reason === '' ? `HTTP ${response.status}` : reason)
      error.status = response.status
      throw error
    }
  }

  /**
   * Make the engine hold this preset's weights.
   *
   * This is the part of GPT-SoVITS' native flow the first version was missing: a
   * voice is the *pair* of trained models plus the reference clip, not a single
   * audio file. Both setters are GET-only and global, so the calls are ordered
   * and only issued when the pair changed.
   */
  const ensureWeights = async ({ voice, settings: effective, signal }) => {
    if (voice.gptWeights !== '' && voice.gptWeights !== activeGpt) {
      await callEngineGetter(effective.serverUrl, '/set_gpt_weights', { weights_path: voice.gptWeights }, signal)
      activeGpt = voice.gptWeights
    }
    if (voice.sovitsWeights !== '' && voice.sovitsWeights !== activeSovits) {
      await callEngineGetter(effective.serverUrl, '/set_sovits_weights', { weights_path: voice.sovitsWeights }, signal)
      activeSovits = voice.sovitsWeights
    }
  }

  /**
   * Synthesize one text through the GPT-SoVITS API.
   *
   * Returns raw WAV bytes: `api_v2.py` answers `/tts` with audio, and only that
   * — a JSON envelope exists solely as a third-party patch, so it is not used.
   *
   * CREDIT: the request shape and defaults below follow `dsh-say`
   * (https://github.com/fangqian616/dsh-say, MIT), `lib/engines/gptsovits.js`,
   * which was read as the specification for driving `api_v2.py`. The endpoint
   * contract itself is upstream: RVC-Boss/GPT-SoVITS `api_v2.py` (MIT). See
   * THIRD-PARTY-NOTICES.md.
   */
  const synthesize = async ({ text, voice, settings: effective, signal, splitMethod, express }) => {
    if (voice === undefined) throw new Error('voice-required')
    if (voice.refAudioPath === '') throw new Error('reference-audio-required')
    /*
     * When the engine runs on this machine, check the reference clip here first.
     * Otherwise a bad path reaches the engine, which answers the generic
     * "tts failed", and the user has no way to tell a wrong path from a wrong
     * model or a broken engine.
     */
    const refIsRemote = /^https?:\/\//i.test(voice.refAudioPath)
    if (!refIsRemote && !existsSync(voice.refAudioPath)) {
      throw new Error(`reference audio not found: ${voice.refAudioPath}`)
    }
    await ensureWeights({ voice, settings: effective, signal })
    /*
     * Per-sentence expression. `express` carries the user's own numbers, clamped to the
     * ranges the engine behaves in, and anything absent falls back to the value that was
     * used before these controls existed — so a request that does not mention them is
     * byte-identical to the old behaviour.
     *
     * Deliberately excluded: `sample_steps` and `super_sampling`, which decide generation
     * *quality*. Those describe how much work the engine does, not how the voice sounds,
     * and changing them mid-reply would make two sentences of one answer differ in fidelity.
     */
    const clamp = (value, low, high, fallback) => {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(Math.max(number, low), high)
    };
    const expressSettings = express !== null && typeof express === 'object' ? express : {};
    const payload = {
      text,
      text_lang: effective.textLang,
      ref_audio_path: voice.refAudioPath,
      prompt_text: voice.promptText,
      prompt_lang: voice.promptLang,
      // Sampling temperature: the main "expression" dial. 1 is the engine's own default.
      temperature: clamp(expressSettings.temperature, 0.05, 2, 1),
      top_k: Math.round(clamp(expressSettings.topK, 1, 100, 15)),
      top_p: clamp(expressSettings.topP, 0.05, 1, 1),
      /*
       * `cut5` splits the request on punctuation inside the engine; `cut0` sends it as
       * one piece.
       *
       * The client decides which per request. Streaming text goes one sentence at a
       * time with `cut0`, so a second splitter cannot disagree with the first and drop
       * half-finished audio. A settled summary is packed into blocks, and there `cut5`
       * lets the engine cut inside a block on its own boundaries rather than
       * synthesizing a long paragraph as one utterance.
       *
       * Default is `cut0`: a request with no preference must not be split, because an
       * unexpected split is what produced truncation in the first place.
       */
      text_split_method: splitMethod === 'cut5' ? 'cut5' : 'cut0',
      batch_size: 1,
      speed_factor: clamp(expressSettings.speed, 0.5, 2, effective.speed),
      /*
       * No silence between fragments inside one request.
       *
       * The engine's default is 0.3 s, which is what made the gaps between sentences long
       * and uneven: the plugin asked the engine not to split, but a block handed over with
       * `cut5` was still split internally, and every one of those internal boundaries added
       * 0.3 s of its own. The gaps are now inserted by the player, measured against the
       * punctuation that ended each sentence, so the engine must not add any.
       */
      fragment_interval: 0,
      seed: -1,
      media_type: 'wav',
      streaming_mode: false,
      parallel_infer: true,
      repetition_penalty: 1.35,
      sample_steps: effective.sampleSteps,
      super_sampling: false,
    }
    const timeout = AbortSignal.timeout(effective.timeoutMs)
    const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await engineFetch(`${effective.serverUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: composite,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const body = detail.slice(0, 400)
      let reason = body
      try {
        const parsed = JSON.parse(body)
        reason = String(parsed.message ?? parsed.detail ?? body)
      } catch {
        /* keep the raw body */
      }
      const error = new Error(reason === '' ? `HTTP ${response.status}` : reason)
      error.status = response.status
      throw error
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw new Error('engine returned no audio')
    // A well-formed WAV starts with "RIFF"; anything else means the engine
    // answered with an error page that still carried a 200.
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('engine response was not WAV audio')
    }
    return bytes
  }

  /** Serialize the fields the client is shown, so both responses stay in step. */
  const settingsView = (effective) => ({
    serverUrl: effective.serverUrl,
    engineRoot: effective.engineRoot,
    defaultVoice: effective.defaultVoice,
    textLang: effective.textLang,
    speed: effective.speed,
    sampleSteps: effective.sampleSteps,
    greetOnStart: effective.greetOnStart,
    greetText: effective.greetText,
    voices: effective.voices,
  })

  /**
   * Synthesize and keep the clip in memory, returning the same-origin URL to play it.
   *
   * The whole operation runs inside the engine queue: switching weights is global state,
   * so a synthesis must not start between a sibling's weight switch and its own.
   *
   * `express` carries the per-sentence expression settings; they are part of the cache key
   * because the same text at a different temperature is a different clip.
   */
  const speak = async ({ text, voiceName, signal, splitMethod, express }) => {
    const effective = settings()
    const wanted = typeof voiceName === 'string' && voiceName.trim() !== '' ? voiceName.trim() : effective.defaultVoice
    const voice =
      effective.voices.find((candidate) => candidate.name === wanted) ??
      (wanted === '' ? effective.voices[0] : undefined)
    if (voice === undefined) throw new Error('voice-required')

    const expressKey =
      express !== null && typeof express === 'object'
        ? [express.speed ?? '', express.temperature ?? '', express.topK ?? '', express.topP ?? ''].join(',')
        : '';

    // The weights are part of a voice's identity, so they belong in the key: the
    // same text in the same reference audio is a different clip under a
    // different trained model.
    const key = digest(
      [
        text,
        voice.name,
        voice.gptWeights,
        voice.sovitsWeights,
        voice.refAudioPath,
        voice.promptText,
        voice.promptLang,
        effective.textLang,
        effective.speed,
        effective.sampleSteps,
        effective.serverUrl,
        expressKey,
      ].join('\u0000'),
    )
    const cached = audioCache.get(key)
    if (cached !== undefined) {
      rememberSynthesis({ text: text.slice(0, 60), voice: voice.name, cached: true, at: Date.now(), ms: 0 })
      return { url: `${ROUTE_PREFIX}/audio/${key}.wav`, bytes: cached.buffer.byteLength, cached: true, voice: voice.name }
    }

    const started = Date.now()
    const audio = await withEngine(() => synthesize({ text, voice, settings: effective, signal, splitMethod, express }))
    rememberAudio(key, { buffer: audio, contentType: 'audio/wav', createdAt: Date.now() })
    rememberSynthesis({
      text: text.slice(0, 60),
      voice: voice.name,
      cached: false,
      at: Date.now(),
      ms: Date.now() - started,
      bytes: audio.length,
    })
    return { url: `${ROUTE_PREFIX}/audio/${key}.wav`, bytes: audio.length, cached: false, voice: voice.name }
  }

  /** The one JSON endpoint the client talks to. */
  const handleApi = async (req, res, url) => {
    const action = url.searchParams.get('action') ?? ''
    const method = req.method ?? 'GET'

    if (action === 'settings' && method === 'GET') {
      const effective = settings()
      sendJson(res, 200, {
        ok: true,
        settings: settingsView(effective),
        languages: LANGUAGES,
        stateDir,
      })
      return
    }

    if (action === 'settings' && method === 'POST') {
      if (!guardOrigin(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad-body' })
        return
      }
      writeUserFile(body)
      const effective = settings()
      sendJson(res, 200, { ok: true, settings: settingsView(effective) })
      return
    }

    /*
     * Discover the trained models a checkout offers, so the settings page can
     * offer them instead of asking for a path that must be readable by the
     * engine process.
     */
    if (action === 'models') {
      const effective = settings()
      const discovered = listWeights(effective.engineRoot)
      // Remember what discovery found: starting the engine needs a checkout, and
      // the settings page is where discovery has run by the time a user asks for
      // the engine to come up.
      if (discovered.engineRoot !== '') resolvedEngineRoot = discovered.engineRoot
      sendJson(res, 200, {
        ok: true,
        engineRoot: discovered.engineRoot,
        configuredRoot: effective.engineRoot,
        gpt: discovered.gpt,
        sovits: discovered.sovits,
      })
      return
    }

    /*
     * Client-side diagnostics.
     *
     * The browser half cannot be inspected from the host, so the decisions it
     * makes about when to speak are reported here and appended to a log the
     * host can read back. This exists because "auto-read is silent" has several
     * possible causes that are indistinguishable from the outside — the toggle
     * being off, the reply already having been read, the driver not being
     * mounted for the owning turn — and each one needs a different fix.
     */
    if (action === 'diag' && method === 'POST') {
      if (!guardOrigin(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad-body' })
        return
      }
      try {
        mkdirSync(stateDir, { recursive: true })
        appendFileSync(diagPath, `${new Date().toISOString()} ${JSON.stringify(body)}\n`, 'utf8')
      } catch {
        /* diagnostics must never break the feature they observe */
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (action === 'diag-read') {
      try {
        const text = readFileSync(diagPath, 'utf8')
        const lines = text.trimEnd().split('\n')
        const tail = lines.slice(-120)
        sendJson(res, 200, { ok: true, path: diagPath, lines: lines.length, entries: tail })
      } catch {
        sendJson(res, 200, { ok: true, path: diagPath, lines: 0, entries: [] })
      }
      return
    }

    if (action === 'health') {
      const effective = settings()
      const health = await probeHealth(effective.serverUrl)
      sendJson(res, 200, { ok: true, ...health, voices: effective.voices.length })
      return
    }

    /*
     * Bring the engine up on demand.
     *
     * The keep-alive timer already covers this, but a user staring at a failure
     * should not have to wait for the next tick, and the client uses this to
     * turn "cannot reach the engine" into "starting it now, try again".
     */
    if (action === 'ensure-engine' && method === 'POST') {
      if (!guardOrigin(req, res)) return
      const result = await ensureEngine('request')
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (action === 'synthesize' && method === 'POST') {
      if (!guardOrigin(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad-body' })
        return
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(res, 400, { ok: false, error: 'text-required' })
        return
      }
      if (text.length > MAX_TEXT_CHARS) {
        sendJson(res, 413, { ok: false, error: 'text-too-large', limit: MAX_TEXT_CHARS })
        return
      }
      const controller = new AbortController()
      req.on('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      try {
        const result = await speak({
            text,
            voiceName: body.voice,
            signal: controller.signal,
            splitMethod: body.splitMethod,
            // Per-sentence expression, chosen by the user, validated and clamped on the host.
            express: body.express,
          })
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'synthesis-failed'
        sendJson(res, 502, { ok: false, error: 'synthesis-failed', message })
      }
      return
    }

    /*
     * The engine's own console output, and the supervisor's decisions.
     *
     * This replaces the API window the user used to keep open beside DSH. A separate
     * window was the wrong shape twice over: it stole focus, and closing it killed the
     * engine. Reading the same content from a panel inside DSH has neither problem.
     */
    if (action === 'logs') {
      /**
       * Read a captured log, tolerating the code page of an older supervisor.
       *
       * The supervisor now forces the engine to emit UTF-8 (`PYTHONIOENCODING`), which is
       * what this decodes. A supervisor from before that change wrote the engine's own
       * cp936 bytes verbatim, so this detects that case and re-decodes instead of showing
       * mojibake. The test is a replacement character: valid UTF-8 never contains one, and
       * a wrong decode of Chinese text almost always does.
       */
      const readTail = (file) => {
        const buffer = readFileSync(file)
        let text = buffer.toString('utf8')
        if (text.includes('\uFFFD')) {
          try {
            const redecoded = new TextDecoder('gbk').decode(buffer)
            if (!redecoded.includes('\uFFFD')) text = redecoded
          } catch {
            /* no gbk decoder in this runtime: keep the utf-8 reading */
          }
        }
        return text
      }
      const tail = (file, limit) => {
        try {
          if (!existsSync(file)) return { path: file, lines: [], bytes: 0 }
          const text = readTail(file)
          const all = text.split('\n')
          const lines = all.slice(Math.max(0, all.length - limit))
          return { path: file, lines, bytes: text.length }
        } catch (error) {
          return { path: file, lines: [`could not read: ${error instanceof Error ? error.message : String(error)}`], bytes: 0 }
        }
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 300), 20), 2000)
      sendJson(res, 200, {
        ok: true,
        engine: tail(engineOutputPath(), limit),
        supervisor: tail(engineLogPath(), limit),
        transcript: recentSynthesis.slice(0, 30),
      })
      return
    }

    /*
     * What the plugin is doing right now.
     *
     * Built because "the greeting did not arrive" had no answer: the engine may be
     * loading models, a preview may be holding the single worker, or the greeting may
     * already have been synthesized and simply not played. Those look identical from
     * outside, and this route is what tells them apart.
     */
    if (action === 'status') {
      const effective = settings()
      const voice =
        effective.voices.find((candidate) => candidate.name === effective.defaultVoice) ?? effective.voices[0]
      let voiceReady = false
      if (voice !== undefined && voice.refAudioPath !== '') {
        try {
          voiceReady = existsSync(voice.refAudioPath)
        } catch {
          voiceReady = false
        }
      }
      sendJson(res, 200, {
        ok: true,
        serverUrl: effective.serverUrl,
        engineRoot: resolvedEngineRoot !== '' ? resolvedEngineRoot : effective.engineRoot,
        voiceName: voice === undefined ? null : voice.name,
        voiceReady,
        voiceCount: effective.voices.length,
        textLang: effective.textLang,
        speed: effective.speed,
        sampleSteps: effective.sampleSteps,
        activeGpt,
        activeSovits,
        busy: engineQueueBusy() || greetingPromise !== undefined,
        greetingBusy: greetingPromise !== undefined,
        greeting: {
          enabled: effective.greetOnStart,
          text: effective.greetText,
          state: greetingResult !== undefined ? 'ready' : greetingPromise !== undefined ? 'synthesizing' : 'idle',
          bytes: greetingResult === undefined ? null : greetingResult.bytes,
          url: greetingResult === undefined ? null : greetingResult.url,
          error: greetingError === undefined ? null : greetingError,
        },
        audioCache: audioCache.size,
        audioCacheBytes: audioCacheBytes,
        audioCacheLimitBytes: AUDIO_CACHE_BYTES,
        history: recentSynthesis.slice(0, 12),
      })
      return
    }

    /*
     * The startup greeting.
     *
     * It is a **real synthesis**, never a bundled audio file, and it serves two
     * purposes at once:
     *
     *  1. it proves the whole chain works — plugin loaded, engine answering, weights
     *     and reference audio resolvable — without the user having to click anything;
     *  2. it is the warm-up. GPT-SoVITS loads its weights, BERT and CNHuBERT on the
     *     first `/tts` of a session, which is the 10-30 s cold start. Doing that
     *     while saying hello means the user's first real request is already fast.
     *
     * The work is kicked off at boot (see the warm-up effect below) rather than
     * here, so the model loads during the seconds the page spends mounting instead
     * of after. This route reports and serves that result.
     */
    if (action === 'greeting') {
      /*
       * Answer immediately, always.
       *
       * The client asks every 500 ms and needs to know whether to play or to ask again.
       * Blocking here until the engine is free would make one outstanding request per
       * 500 ms pile up behind a cold start, so the gate state comes back right away and
       * the synthesis only starts when the engine is genuinely idle.
       */
      const gate = greetingGate()
      if (gate.state === 'disabled') {
        sendJson(res, 200, { ok: true, enabled: false, state: gate.state })
        return
      }
      if (greetingResult !== undefined) {
        sendJson(res, 200, { ok: true, enabled: true, state: 'ready', ...greetingResult })
        return
      }
      if (gate.state !== 'idle') {
        // `engine-down` is reported as such so the console shows why nothing happened.
        sendJson(res, 200, {
          ok: false,
          enabled: true,
          state: gate.state,
          error: gate.state === 'engine-down' ? 'engine-down' : 'greeting-pending',
          message: greetingError ?? null,
        })
        return
      }
      /* Nothing in flight and the engine is free: synthesize, then hand it back. */
      const result = await warmGreeting()
      if (result === undefined) {
        sendJson(res, 200, {
          ok: false,
          enabled: true,
          state: greetingError === undefined ? 'pending' : 'failed',
          error: 'greeting-failed',
          message: greetingError ?? 'greeting not ready',
        })
        return
      }
      sendJson(res, 200, { ok: true, enabled: true, state: 'ready', ...result })
      return
    }

    sendJson(res, 404, { ok: false, error: 'unknown-action' })
  }

  /** Serve one synthesized clip, straight out of memory. */
  const handleAudio = async (req, res, url) => {
    const match = /^\/gpt-sovits\/audio\/([0-9a-f]{8,64})\.wav$/.exec(url.pathname)
    if (match === null) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    const clipId = match[1]
    const entry = audioCache.get(clipId)
    if (entry === undefined) {
      /*
       * Not on disk either: audio lives in memory only, so this means the clip was evicted
       * or the host restarted. The client treats it as a miss and re-requests, which is
       * why the route answers `clip-missing` rather than an empty 200.
       */
      sendJson(res, 404, { ok: false, error: 'clip-missing' })
      return
    }
    res.writeHead(200, {
      'content-type': entry.contentType ?? 'audio/wav',
      'content-length': entry.buffer.byteLength,
      // The id is a content digest, so the bytes behind it never change.
      'cache-control': 'private, max-age=86400',
    })
    res.end(entry.buffer)
  }

  const mount = () => {
    const web = ctx.get('webServer')
    if (web === undefined) return
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/api`,
          handler: (req, res) => {
            if (!guardLoopback(req, res)) return
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            void handleApi(req, res, url).catch((error) => {
              if (res.writableEnded) return
              sendJson(res, 500, {
                ok: false,
                error: 'internal',
                message: error instanceof Error ? error.message : String(error),
              })
            })
          },
        }),
      'gpt-sovits: api route',
    )
    ctx.effect(
      () =>
        web.register({
          kind: 'prefix',
          path: `${ROUTE_PREFIX}/audio`,
          handler: (req, res) => {
            if (!guardLoopback(req, res)) return
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            void handleAudio(req, res, url).catch(() => {
              if (res.writableEnded) return
              sendJson(res, 500, { ok: false, error: 'internal' })
            })
          },
        }),
      'gpt-sovits: audio route',
    )
  }

  /**
   * Ask the supervisor to bring the engine up.
   *
   * The supervisor (`lib/supervisor.py`, run through `pythonw.exe`) owns the
   * engine process, so two things follow from spawning it instead of running the
   * old batch launcher:
   *
   *  - **No console flicker.** The batch wait loop used `ping` as its delay, and
   *    `ping.exe` is a console program, so a cold start flashed a window per
   *    poll. Here the wait is a socket connect inside one windowless process.
   *  - **The engine dies with DSH.** `--adopt-pid` is this process, and the
   *    supervisor terminates the engine it started as soon as that pid is gone.
   *
   * It is spawned detached so it survives this plugin unloading, which is what
   * lets it watch DSH rather than this module's lifetime.
   */
  const spawnLauncher = (reason) => {
    const paths = launcherPaths(settings().engineRoot === '' ? discoveredEngineRoot() : settings().engineRoot)
    if (paths === undefined) {
      ctx.logger?.warn?.(
        'gpt-sovits: no usable engine checkout to start from; set the checkout directory in the settings page',
      )
      return false
    }
    const supervisor = join(import.meta.dirname, 'supervisor.py')
    if (!existsSync(supervisor)) {
      ctx.logger?.warn?.(`gpt-sovits: supervisor missing at ${supervisor}`)
      return false
    }
    const args = [
      supervisor,
      '--adopt-pid', String(process.pid),
      '--server', settings().serverUrl,
      '--engine-root', paths.engineRoot,
      '--api', paths.api,
      '--python', paths.python,
      '--state-dir', stateDir,
      '--log', engineLogPath(),
      '--engine-log', engineOutputPath(),
    ]
    if (paths.yaml !== '') args.push('--yaml', paths.yaml)
    try {
      const child = spawn(paths.python, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      ctx.logger?.info?.(`gpt-sovits: asked the supervisor to start the engine (${reason})`)
      return true
    } catch (error) {
      ctx.logger?.warn?.(
        `gpt-sovits: could not run the supervisor: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /** The checkout the plugin last resolved, for the start path. */
  const discoveredEngineRoot = () => resolvedEngineRoot

  /** Where the supervisor reports what it did. */
  const engineLogPath = () => join(stateDir, 'engine-start.log')

  /**
   * Where the engine's own stdout/stderr is captured.
   *
   * This is the content of the API console window: weight loading, the text being
   * synthesized, the per-request access lines and any traceback. It used to go to
   * DEVNULL, which is why engine-side failures were invisible from the UI, and it is
   * now shown in the plugin's side panel.
   */
  const engineOutputPath = () => join(stateDir, 'engine-output.log')

  /** The supervisor's pid record, or undefined when there is none to trust. */
  const readEnginePidFile = () => {
    const file = join(stateDir, 'engine.pid')
    try {
      if (!existsSync(file)) return undefined
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      // A half-written file is not a reason to fail boot; the supervisor
      // rewrites it on the next start.
      return undefined
    }
  }

  /** True when a process with that pid exists. Assumes alive when unsure. */
  const isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // ESRCH means gone; EPERM means it exists but is not ours to signal.
      return error !== null && typeof error === 'object' && error.code === 'EPERM'
    }
  }


  /**
   * Stop the supervisor and the engine it owns.
   *
   * DSH exiting already stops both, because the supervisor watches this pid.
   * This covers the other exit: the plugin being unloaded while DSH stays up.
   */
  const stopEngine = () => {
    const paths = launcherPaths(settings().engineRoot === '' ? resolvedEngineRoot : settings().engineRoot)
    if (paths === undefined) return false
    const supervisor = join(import.meta.dirname, 'supervisor.py')
    if (!existsSync(supervisor)) return false
    try {
      const child = spawn(paths.python, [supervisor, '--stop', '--state-dir', stateDir, '--log', engineLogPath()], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      return false
    }
  }


  /**
   * Keep the engine up for as long as DSH runs.
   *
   * Nothing is started when the engine already answers, and a launcher already
   * in flight is not duplicated. The first check runs immediately: DSH dying is
   * exactly what kills the engine in practice, so the gap right after a restart
   * is the one that matters, and waiting for the external watchdog's poll would
   * leave the voice dead for minutes.
   */
  let launching = false
  const ensureEngine = async (reason) => {
    if (launching) return { running: true, launched: false, note: 'launcher already in flight' }
    const health = await probeHealth(settings().serverUrl)
    if (health.running) return { running: true, launched: false, note: health.detail }
    launching = true
    const started = spawnLauncher(reason)
    // The launcher waits for readiness itself; release the flag once it has had
    // time to bind the port, so a genuinely failed start can be retried.
    const timer = setTimeout(() => {
      launching = false
    }, 240000)
    timer.unref?.()
    return { running: false, launched: started, note: started ? 'launcher started' : 'no launcher in the state dir' }
  }

  /*
   * The greeting, driven by polling instead of by timing guesses.
   *
   * Every previous attempt to schedule this failed on a real machine, because every
   * one of them was a guess about when the engine would be ready: a fixed delay fired
   * before the engine had bound its port, and a readiness wait still assumed the boot
   * path was the only thing competing for the engine.
   *
   * The rule now is simply: **produce the greeting when the engine is free, and never
   * while it is working.** The client asks every 500 ms; each ask checks the engine's
   * state, and if it is up and idle the greeting is synthesized and handed back. The
   * state check reads local variables only, so it can run as often as the caller likes
   * without touching the engine.
   *
   * The greeting is still deliberately a **real synthesis**, not a bundled clip: that is
   * what makes it prove the whole chain works, and what loads weights, BERT and
   * HuBERT so the user's first real sentence does not pay the cold start.
   */
  let greetingPromise
  let greetingResult
  let greetingError
  const greetingEnabled = () => {
    const effective = settings()
    return effective.greetOnStart && effective.greetText.trim() !== ''
  }

  /**
   * Whether the engine can take the greeting right now.
   *
   * `busy` is the important half: starting the greeting while a real request is in
   * flight would queue behind it, and the greeting would then arrive *after* the reply
   * it was supposed to precede. Reachability comes from the cached health so the check
   * stays a variable read.
   */
  const greetingGate = () => {
    if (!greetingEnabled()) return { state: 'disabled' }
    if (greetingResult !== undefined) return { state: 'ready' }
    if (greetingPromise !== undefined) return { state: 'synthesizing' }
    if (engineQueueBusy()) return { state: 'engine-busy' }
    const health = recentHealth()
    if (health === undefined) return { state: 'probing' }
    if (!health.running) return { state: 'engine-down' }
    return { state: 'idle' }
  }

  /**
   * Run the greeting if, and only if, the engine is free.
   *
   * Returns the clip once it exists. The in-flight latch is released in `finally` on
   * every path: leaving it set on failure is what previously made a single transient
   * error silence the greeting for the whole session.
   */
  const warmGreeting = async () => {
    if (greetingResult !== undefined) return greetingResult
    if (greetingPromise !== undefined) return greetingPromise
    if (greetingGate().state !== 'idle') return undefined
    const text = settings().greetText.trim()
    greetingPromise = (async () => {
      try {
        /*
         * `speak` is called directly, never wrapped in `withEngine`.
         *
         * `speak` already queues its own synthesis internally, and `withEngine` is a
         * serial chain. Wrapping it once more nests the queue inside itself: the outer
         * entry holds the chain while the inner one waits for it, and the greeting hangs
         * in `synthesizing` forever with the engine reported busy. That is exactly what
         * happened, so this call must stay un-nested.
         */
        const result = await speak({ text, signal: undefined })
        greetingResult = { text, ...result }
        greetingError = undefined
        ctx.logger?.info?.(`gpt-sovits: greeting ready (${result.bytes} bytes) — engine warm`)
        return greetingResult
      } catch (error) {
        greetingError = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`gpt-sovits: greeting failed: ${greetingError}`)
        return undefined
      } finally {
        greetingPromise = undefined
      }
    })()
    return greetingPromise
  }




  if (ctx.get('webServer') !== undefined) mount()
  else ctx.inject(['webServer'], () => mount())

  /*
   * One-time housekeeping: an installation upgrading into the memory-only design still has
   * the old WAV files on disk (a hundred megabytes, in the case that prompted this).
   * Removing them here means the change actually reclaims the space, and the count is
   * logged so the run is visible rather than silent.
   */
  ctx.effect(() => {
    const removed = purgeLegacyAudioFiles()
    if (removed > 0) ctx.logger?.info?.(`gpt-sovits: removed ${removed} on-disk clips; audio is memory-only now`)
  }, 'gpt-sovits: purge legacy audio files')

  ctx.effect(() => {
    void (async () => {
      const health = await probeHealth(settings().serverUrl)
      if (health.running) {
        ctx.logger?.info?.(`gpt-sovits: engine already reachable at ${health.serverUrl}`)
        return
      }
      ctx.logger?.info?.(`gpt-sovits: engine not reachable at ${health.serverUrl} — starting it`)
      const result = await ensureEngine('startup')
      if (!result.launched) {
        ctx.logger?.warn?.(
          'gpt-sovits: no launcher found; run the engine by hand or start the settings-page probe',
        )
      }
    })()
  }, 'gpt-sovits: start the engine on boot')

  /*
   * Engine state heartbeat: every 100 ms, as the design requires.
   *
   * Two jobs, both cheap:
   *
   *  1. **Local, at 100 ms.** Record whether the engine is working, and remember when it
   *     last went idle. Reading two variables costs nothing, and this is the signal the
   *     greeting gate uses to stand down the moment real work starts.
   *  2. **Reachability, on a slow tick.** `probeHealth` is an HTTP round trip, so it runs
   *     every 2 s instead of every 100 ms -- ten probes a second would compete with the
   *     synthesis they are meant to observe. `busy` is sampled on the fast tick, so the
   *     answer to "is the engine busy?" never waits for a probe.
   */
  ctx.effect(() => {
    const FAST_MS = 100
    const PROBE_EVERY = 20 // 20 * 100 ms = 2 s
    let ticks = 0
    let lastBusy = false
    const timer = setInterval(() => {
      const busy = engineQueueBusy()
      if (busy !== lastBusy) {
        lastBusy = busy
        ctx.logger?.info?.(`gpt-sovits: engine ${busy ? 'busy' : 'idle'}`)
      }
      ticks += 1
      if (ticks % PROBE_EVERY !== 0) return
      /*
       * Both handlers are required. `probeHealth` catches its own transport errors, but
       * a bare `.then()` chain still leaks anything unforeseen: an unhandled rejection
       * here would take the heartbeat down and leave the greeting permanently `probing`,
       * which is exactly the silent-death mode this whole design is meant to remove.
       */
      probeHealth(settings().serverUrl).then(
        (health) => {
          healthCache = health
        },
        (error) => {
          healthCache = { running: false, serverUrl: settings().serverUrl, detail: String(error) }
        },
      )
    }, FAST_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'gpt-sovits: engine state heartbeat')

  // Backstop for a crash long after boot: the external scheduled task polls
  // every five minutes, this polls far more often while DSH is open.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureEngine('keep-alive')
    }, 60000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'gpt-sovits: engine keep-alive')

  /*
   * Kill an engine left behind by a previous DSH that died without running its
   * shutdown path. The supervisor covers a clean exit and a force-kill, but not
   * a machine losing power mid-session; this is the sweep for that case, and it
   * finds the process through the pid file the supervisor writes.
   */
  ctx.effect(() => {
    void (async () => {
      const record = readEnginePidFile()
      if (record === undefined) return
      const owner = Number(record.dsh_pid ?? 0)
      if (owner <= 0 || owner === process.pid) return
      if (isProcessAlive(owner)) return
      ctx.logger?.warn?.(`gpt-sovits: engine left over from a dead DSH (pid ${owner}); stopping it`)
      stopEngine()
    })()
  }, 'gpt-sovits: reap an orphaned engine')

  /*
   * Stop the engine when this plugin unloads while DSH stays up. DSH exiting is
   * handled by the supervisor watching this process; this is the other exit.
   */
  ctx.effect(() => () => {
    stopEngine()
  }, 'gpt-sovits: stop the engine when the plugin unloads')
}
