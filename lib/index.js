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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

export const name = 'gpt-sovits'

/** Settings echoed to the client; the client never sees anything else. */
const MAX_TEXT_CHARS = 4000
const AUDIO_CACHE_LIMIT = 120
const DEFAULT_SERVER_URL = 'http://127.0.0.1:9880'
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
 * Write the little batch fragment the engine launcher sources.
 *
 * `start-engine.bat` runs outside the plugin and has no JSON parser, and `call`
 * cannot take a quoted path containing `-` (cmd reads it as a label, and 8.3
 * truncation mangles it), so the launcher's port and engine directory are
 * regenerated here every time settings are saved. That keeps the autostart
 * pointed at whatever engine the user last configured.
 */
function writeLauncherDefaults(stateDir, effective) {
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
}

/**
 * Mount the plugin.
 *
 * @param ctx - Host context; `webServer` provides the HTTP carrier.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const stateDir = String(config.stateDir ?? '').trim() === '' ? defaultStateDir() : resolve(String(config.stateDir))
  const audioDir = join(stateDir, 'audio')
  const settingsPath = join(stateDir, 'settings.json')
  const diagPath = join(stateDir, 'diag.log')

  const ensureDirs = () => {
    mkdirSync(audioDir, { recursive: true })
    return audioDir
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
    if (Array.isArray(patch.voices)) next.voices = patch.voices.map(normalizeVoice).filter((voice) => voice !== undefined)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    // Keep the standalone engine launcher in step with the saved settings.
    writeLauncherDefaults(stateDir, effectiveSettings(config, next))
    return next
  }

  const settings = () => effectiveSettings(config, readUserFile())

  /** clipId -> { file, bytes, contentType, createdAt } */
  const audioCache = new Map()

  /** Insert with FIFO eviction; the browser holds the URL only long enough to play it. */
  const rememberAudio = (clipId, entry) => {
    if (audioCache.size >= AUDIO_CACHE_LIMIT) {
      const oldest = audioCache.keys().next().value
      if (oldest !== undefined) audioCache.delete(oldest)
    }
    audioCache.set(clipId, entry)
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
      const response = await fetch(`${base}/control`, { signal: controller.signal })
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
  const withEngine = (operation) => {
    const run = engineQueue.then(operation, operation)
    // Keep the chain alive after a failure; the failure itself is reported to
    // the caller that caused it.
    engineQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Call one of the GET-only weight setters, which answer with a JSON message. */
  const callEngineGetter = async (serverUrl, path, params, signal) => {
    const url = new URL(`${serverUrl}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const timeout = AbortSignal.timeout(120000)
    const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await fetch(url, { signal: composite })
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
  const synthesize = async ({ text, voice, settings: effective, signal }) => {
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
    const payload = {
      text,
      text_lang: effective.textLang,
      ref_audio_path: voice.refAudioPath,
      prompt_text: voice.promptText,
      prompt_lang: voice.promptLang,
      top_k: 15,
      top_p: 1,
      temperature: 1,
      text_split_method: 'cut5',
      batch_size: 1,
      speed_factor: effective.speed,
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
    const response = await fetch(`${effective.serverUrl}/tts`, {
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
    voices: effective.voices,
  })

  /**
   * Synthesize, persist the clip, and return the same-origin URL to play it.
   *
   * The whole operation runs inside the engine queue: switching weights is
   * global state, so a synthesis must not start between a sibling's weight
   * switch and its own.
   */
  const speak = async ({ text, voiceName, signal }) => {
    const effective = settings()
    const wanted = typeof voiceName === 'string' && voiceName.trim() !== '' ? voiceName.trim() : effective.defaultVoice
    const voice =
      effective.voices.find((candidate) => candidate.name === wanted) ??
      (wanted === '' ? effective.voices[0] : undefined)
    if (voice === undefined) throw new Error('voice-required')

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
      ].join('\u0000'),
    )
    const cached = audioCache.get(key)
    if (cached !== undefined) {
      return { url: `${ROUTE_PREFIX}/audio/${key}.wav`, bytes: cached.bytes, cached: true, voice: voice.name }
    }

    const audio = await withEngine(() => synthesize({ text, voice, settings: effective, signal }))
    ensureDirs()
    writeFileSync(join(audioDir, `${key}.wav`), audio)
    rememberAudio(key, { bytes: audio.length, createdAt: Date.now() })
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
        const result = await speak({ text, voiceName: body.voice, signal: controller.signal })
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'synthesis-failed'
        sendJson(res, 502, { ok: false, error: 'synthesis-failed', message })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'unknown-action' })
  }

  /** Serve one synthesized clip. */
  const handleAudio = async (req, res, url) => {
    const match = /^\/gpt-sovits\/audio\/([0-9a-f]{8,64})\.wav$/.exec(url.pathname)
    if (match === null) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    const clipId = match[1]
    try {
      const bytes = readFileSync(join(audioDir, `${clipId}.wav`))
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': bytes.length,
        // The id is a content digest, so the bytes behind it never change.
        'cache-control': 'private, max-age=86400',
      })
      res.end(bytes)
    } catch {
      sendJson(res, 404, { ok: false, error: 'clip-missing' })
    }
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
   * Ask the standalone launcher to bring the engine up.
   *
   * The launcher is idempotent (it returns immediately when the port already
   * answers) and writes its own log, so this is safe to call speculatively. It
   * is spawned detached and unreferenced on purpose: the engine must outlive
   * DSH, which is the whole reason it is not started as a plain child. A plain
   * child would be killed with its parent, and restarting DSH would silence the
   * voice every single time.
   */
  const spawnLauncher = (reason) => {
    const launcher = join(stateDir, 'start-engine.bat')
    if (!existsSync(launcher)) return false
    try {
      const child = spawn('cmd.exe', ['/c', launcher], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      ctx.logger?.info?.(`gpt-sovits: asked the launcher to start the engine (${reason})`)
      return true
    } catch (error) {
      ctx.logger?.warn?.(
        `gpt-sovits: could not run ${launcher}: ${error instanceof Error ? error.message : String(error)}`,
      )
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

  if (ctx.get('webServer') !== undefined) mount()
  else ctx.inject(['webServer'], () => mount())

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

  // Backstop for a crash long after boot: the external scheduled task polls
  // every five minutes, this polls far more often while DSH is open.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureEngine('keep-alive')
    }, 60000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'gpt-sovits: engine keep-alive')
}
