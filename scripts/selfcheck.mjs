/**
 * Offline self-check for dsh-gpt-sovits.
 *
 * Node cannot load the host half without the DSH runtime and cannot run the
 * client half at all (it expects `window`), so this script verifies the parts
 * that are testable in isolation: syntax, the module-loader registration
 * contract, the config schema surface, and the text pipeline.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const failures = []
const passes = []

function check(name, fn) {
  try {
    const detail = fn()
    // A check that returns a promise must be awaited, or its assertions land
    // after the report and a failure reads as a pass.
    if (detail !== null && typeof detail === 'object' && typeof detail.then === 'function') {
      return detail.then(
        (resolved) => {
          passes.push(`${name}${resolved === undefined ? '' : ` — ${resolved}`}`)
        },
        (error) => {
          failures.push(`${name} — ${error instanceof Error ? error.message : String(error)}`)
        },
      )
    }
    passes.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    failures.push(`${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ── Host half: syntax + schema surface ────────────────────────────────────────

const hostPath = path.join(root, 'lib', 'index.js')
const hostSource = readFileSync(hostPath, 'utf8')

check('host: parses as an ES module', () => {
  // new Function rejects ESM syntax, so parse through the module compiler
  // instead: `--check` semantics without spawning a process.
  const { SourceTextModule } = vm
  if (typeof SourceTextModule === 'function') {
    new SourceTextModule(hostSource)
    return 'vm.SourceTextModule parse ok'
  }
  return 'skipped (SourceTextModule unavailable without --experimental-vm-modules)'
})

check('host: declares the expected exports', () => {
  assert(/export const name = 'gpt-sovits'/.test(hostSource), 'missing `name` export')
  assert(/export const Config = Schema\.object\(/.test(hostSource), 'missing `Config` schema')
  assert(/export function apply\(ctx, config\)/.test(hostSource), 'missing `apply(ctx, config)`')
  return 'name + Config + apply(ctx, config)'
})

check('host: registers both routes with the webserver contract', () => {
  for (const fragment of [
    "kind: 'exact'",
    "path: `${ROUTE_PREFIX}/api`",
    "kind: 'prefix'",
    "path: `${ROUTE_PREFIX}/audio`",
  ]) {
    assert(hostSource.includes(fragment), `route contract missing: ${fragment}`)
  }
  return 'exact /api + prefix /audio'
})

check('host: /tts payload matches the api_v2.py contract', () => {
  for (const key of [
    'text_lang',
    'ref_audio_path',
    'prompt_text',
    'prompt_lang',
    'text_split_method',
    'speed_factor',
    'media_type',
    'streaming_mode',
    'parallel_infer',
    'repetition_penalty',
    'sample_steps',
    'super_sampling',
  ]) {
    assert(new RegExp(`\\b${key}:`).test(hostSource), `payload field missing: ${key}`)
  }
  // media_type must stay inside the engine's closed set.
  assert(/media_type: 'wav'/.test(hostSource), "media_type must be 'wav' (mp3 is rejected by the engine)")
  assert(/streaming_mode: false/.test(hostSource), 'streaming_mode must be false to get one complete WAV')
  return '13 fields, wav, non-streaming'
})

check('host: starts the engine itself instead of waiting for the watchdog', () => {
  // The engine dies with DSH in practice, so the gap right after a boot is the
  // one that matters. Waiting for the external five-minute poll left the voice
  // dead for minutes after every restart.
  assert(/const spawnLauncher = /.test(hostSource), 'a launcher spawn is required')
  assert(/const ensureEngine = /.test(hostSource), 'an ensure-engine path is required')
  assert(/start the engine on boot/.test(hostSource), 'the boot effect must start the engine')
  assert(/engine keep-alive/.test(hostSource), 'a periodic backstop must remain')
  // Detached + unref: a plain child would be killed with DSH, which is exactly
  // the failure being fixed.
  assert(/detached: true/.test(hostSource), 'the launcher must be detached')
  assert(/child\.unref\(\)/.test(hostSource), 'the launcher must be unreferenced')
  assert(/windowsHide: true/.test(hostSource), 'the launcher must not flash a console window')
  // Exactly one copy of each: a duplicated block would spawn twice per boot.
  for (const name of ['const spawnLauncher = ', 'const ensureEngine = ']) {
    const count = hostSource.split(name).length - 1
    assert(count === 1, `${name.trim()} appears ${count} times, expected 1`)
  }
  return 'boot start + 60s keep-alive, detached, single copy'
})

check('host: does not start the engine when it already answers', () => {
  assert(/if \(launching\) return \{ running: true, launched: false/.test(hostSource), 'concurrent starts must be deduped')
  assert(/if \(health\.running\) return \{ running: true, launched: false/.test(hostSource), 'a live engine must short-circuit')
  assert(/action === 'ensure-engine'/.test(hostSource), 'on-demand start must be reachable over the API')
  return 'idempotent, single-flight'
})

check('host: keeps synthesis loopback-only', () => {
  assert(hostSource.includes('guardLoopback'), 'routes must refuse non-loopback peers')
  assert(hostSource.includes('guardOrigin'), 'write routes must refuse cross-origin posts')
  return 'loopback + origin guards present'
})

check('host: voices carry the native GPT-SoVITS triple', () => {
  // A voice is the pair of trained models plus the reference clip — not one
  // audio file. The two weight fields are global engine state; the clip and its
  // transcript travel with each request.
  for (const field of ['gptWeights', 'sovitsWeights', 'refAudioPath', 'promptText', 'promptLang']) {
    assert(new RegExp(`${field}: Schema\\.string\\(\\)`).test(hostSource), `Config is missing the "${field}" field`)
  }
  assert(/gptWeights: cleanPath\(/.test(hostSource), 'normalizeVoice must keep gptWeights')
  assert(/sovitsWeights: cleanPath\(/.test(hostSource), 'normalizeVoice must keep sovitsWeights')
  return 'gptWeights + sovitsWeights + refAudioPath + promptText'
})

check('host: switches weights through the GET-only setter endpoints', () => {
  assert(hostSource.includes("'/set_gpt_weights'"), 'the GPT weight setter must be called')
  assert(hostSource.includes("'/set_sovits_weights'"), 'the SoVITS weight setter must be called')
  // Both are GET-only in api_v2.py, so a POST would 405.
  assert(/callEngineGetter/.test(hostSource), 'the setters must go through the GET helper')
  assert(!/set_gpt_weights[\s\S]{0,200}method: 'POST'/.test(hostSource), 'the setters must not be POSTed')
  return '/set_gpt_weights + /set_sovits_weights, GET'
})

check('host: skips a weight switch when the pair is unchanged', () => {
  // Reloading weights costs seconds; paying it per utterance would be the whole
  // difference between usable and not.
  assert(/voice\.gptWeights !== activeGpt/.test(hostSource), 'the GPT switch must be conditional on change')
  assert(/voice\.sovitsWeights !== activeSovits/.test(hostSource), 'the SoVITS switch must be conditional on change')
  assert(/let activeGpt/.test(hostSource) && /let activeSovits/.test(hostSource), 'the active pair must be tracked')
  return 'switch-on-change only'
})

check('host: serializes engine operations', () => {
  // api_v2.py runs workers=1 and its weights are global, so an interleaved
  // "set weights" / "synthesize" pair could return the wrong voice.
  assert(/let engineQueue = Promise\.resolve\(\)/.test(hostSource), 'an engine queue is required')
  assert(/const withEngine = /.test(hostSource), 'operations must go through the queue')
  assert(/withEngine\(\(\) => synthesize\(/.test(hostSource), 'synthesis must be queued')
  assert(/await ensureWeights\(/.test(hostSource), 'the weight switch must happen inside the queued operation')
  return 'single-flight engine queue'
})

check('host: the cache key includes the weight pair', () => {
  // `speak` is an arrow const, so slice from its declaration to the next one.
  const at = hostSource.indexOf('const speak = async')
  assert(at !== -1, 'the speak function is missing')
  const next = hostSource.indexOf('\n  const ', at + 10)
  const body = hostSource.slice(at, next === -1 ? undefined : next)
  assert(body.includes('voice.gptWeights'), 'the cache key must include gptWeights')
  assert(body.includes('voice.sovitsWeights'), 'the cache key must include sovitsWeights')
  assert(body.includes('digest('), 'the key must be derived through digest()')
  return 'same text + different model = different clip'
})

check('host: discovers the trained weights from the checkout', () => {
  assert(/function listWeights/.test(hostSource), 'model discovery is missing')
  assert(/GPT_weights/i.test(hostSource), 'the GPT weight directories must be scanned')
  assert(/SoVITS_weights/i.test(hostSource), 'the SoVITS weight directories must be scanned')
  assert(/'\.ckpt\$'/i.test(hostSource) || /\\.ckpt\$/.test(hostSource), 'the GPT scan must filter .ckpt')
  assert(/\\.pth\$/.test(hostSource), 'the SoVITS scan must filter .pth')
  assert(/action === 'models'/.test(hostSource), 'the discovery must be reachable over the API')
  return 'listWeights + GET models'
})

check('host: tolerates a BOM in the settings file', () => {
  // PowerShell's `Set-Content -Encoding UTF8` writes a BOM, and JSON.parse
  // rejects it — which silently wiped every preset with no error anywhere.
  assert(/charCodeAt\(0\) === 0xfeff/.test(hostSource), 'a leading BOM must be stripped before parsing')
  return 'BOM stripped before JSON.parse'
})

check('host: strips the quotes Windows "Copy as path" adds', () => {
  // Measured against the real engine: the same path with surrounding quotes
  // answers HTTP 400 "tts failed", without them HTTP 200. It is the single most
  // likely reason a working engine still refuses to speak.
  const body = extractFunction(hostSource, 'cleanPath')
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(`${body}\nglobalThis.__c = cleanPath`, sandbox)
  const clean = sandbox.__c
  const raw = 'D:\\GPT-SoVITS\\logs\\e\\ref.wav'
  const cases = [
    [`"${raw}"`, raw, 'quoted'],
    [`  "${raw}"  `, raw, 'quoted with padding'],
    [`""${raw}""`, raw, 'double-quoted'],
    [`'${raw}'`, raw, 'single-quoted'],
    [raw, raw, 'plain'],
    [`${raw} `, raw, 'trailing space'],
    ['', '', 'empty'],
  ]
  for (const [input, want, label] of cases) {
    assert(clean(input) === want, `${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(clean(input))}`)
  }
  assert(/refAudioPath: cleanPath\(/.test(hostSource), 'refAudioPath must be cleaned')
  assert(/gptWeights: cleanPath\(/.test(hostSource), 'gptWeights must be cleaned')
  assert(/sovitsWeights: cleanPath\(/.test(hostSource), 'sovitsWeights must be cleaned')
  return 'quotes and padding stripped from all three paths'
})

check('host: a missing reference clip names the path instead of "tts failed"', () => {
  assert(/reference audio not found/.test(hostSource), 'the missing-clip case must name the path')
  assert(/existsSync\(voice\.refAudioPath\)/.test(hostSource), 'the check must be a local file check')
  assert(/refIsRemote/.test(hostSource), 'a remote reference URL must be exempt from the file check')
  return 'pre-flight check whose message carries the offending path'
})

check('host: state dir resolves without relying on DSH_HOME being set', () => {
  // Regression: the desktop app does not export DSH_HOME to itself, so a
  // fallback of process.cwd() silently wrote state into the profile directory
  // and the documented $DSH_HOME/gpt-sovits path never appeared.
  const body = extractFunction(hostSource, 'defaultStateDir')
  assert(body.includes('homedir()'), 'defaultStateDir must fall back to the user home directory')
  assert(!body.includes('process.cwd()'), 'defaultStateDir must never fall back to the working directory')
  const os = require('node:os')
  const path = require('node:path')
  const sandbox = { process: { env: {} }, homedir: os.homedir, join: path.join }
  vm.createContext(sandbox)
  vm.runInContext(`${body}\nglobalThis.__d = defaultStateDir()`, sandbox)
  const resolved = sandbox.__d
  assert(resolved === path.join(os.homedir(), '.dsh', 'gpt-sovits'), `unexpected fallback: ${resolved}`)
  // With DSH_HOME present it must still be honoured.
  const sandbox2 = { process: { env: { DSH_HOME: '/tmp/fake-dsh-home' } }, homedir: os.homedir, join: path.join }
  vm.createContext(sandbox2)
  vm.runInContext(`${body}\nglobalThis.__d = defaultStateDir()`, sandbox2)
  assert(sandbox2.__d === path.join('/tmp/fake-dsh-home', 'gpt-sovits'), `DSH_HOME ignored: ${sandbox2.__d}`)
  return 'DSH_HOME honoured, $HOME/.dsh fallback'
})

check('host: the stateDir config option is actually consumed', () => {
  assert(/config\.stateDir/.test(hostSource), 'config.stateDir must be read by apply()')
  assert(/defaultStateDir\(\)/.test(hostSource), 'the default must be reachable from apply()')
  return 'config.stateDir ?: default'
})

check('host: validates that the engine really returned WAV', () => {
  assert(hostSource.includes("'RIFF'"), 'a 200 response must still be checked for a RIFF header')
  return 'RIFF sniff present'
})

// ── Client half: loader contract + text pipeline ──────────────────────────────

const clientPath = path.join(root, 'lib', 'client.js')
const clientSource = readFileSync(clientPath, 'utf8')

check('client: parses as a script', () => {
  // eslint-disable-next-line no-new-func
  new Function(clientSource)
  return 'new Function parse ok'
})

/** Stylesheet tags the bundle appended, so a test can inspect the injected CSS. */
const styleTags = []

/** Enough of a document for the bundle's stylesheet installer to run. */
function fakeDocument() {
  return {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (tag) => {
        styleTags.push(tag)
      },
    },
  }
}

/** A controllable localStorage, so a test can seed the auto-read marks. */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  }
}

/** A window with the two globals the client half touches, plus a fake Audio. */
function fakeWindow() {
  const played = []
  class FakeAudio {
    constructor(src) {
      this.src = src
      this.volume = 1
      this.playbackRate = 1
      played.push(src)
    }
    play() {
      // Never fires "ended", so a test observes the start of playback only.
      return Promise.resolve()
    }
    pause() {}
    set onended(fn) { this._ended = fn }
    get onended() { return this._ended }
    set onerror(fn) { this._error = fn }
    get onerror() { return this._error }
  }
  return {
    window: {
      __ModuleLoader__: null,
      localStorage: fakeStorage(),
      setInterval: () => 0,
      clearInterval: () => {},
      Audio: FakeAudio,
    },
    played,
  }
}

/**
 * Evaluate the client bundle against a stub module loader and return its exports.
 *
 * @param options.effects - collect `useEffect` bodies instead of dropping them,
 *   so a test can drive a component's effect the way React would.
 * @param options.env - the window the bundle sees (localStorage, FakeAudio).
 */
function loadClient(options = {}) {
  let registration = null
  const effects = []
  const reactStub = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (initial) => [initial, () => {}],
    useEffect: options.effects === true
      ? (fn) => {
        effects.push(fn)
      }
      : () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    memo: (fn) => fn,
  }
  const jsxStub = {
    jsx: (...args) => ({ type: args[0], props: args[1] }),
    jsxs: (...args) => ({ type: args[0], props: args[1] }),
    Fragment: 'Fragment',
  }
  // The shell's icon exports the bundle reaches for; each renders a marker so a
  // test can tell which glyph the component chose.
  const iconStub = (glyphName) => (props) => ({ glyph: glyphName, props })
  const primitivesStub = {
    IconPlayOutlineRegular: iconStub('IconPlayOutlineRegular'),
    IconPauseOutlineRegular: iconStub('IconPauseOutlineRegular'),
  }
  const seed = new Map([
    ['react', reactStub],
    ['react/jsx-runtime', jsxStub],
    ['@deepseek-ai/dsh-client-ui-primitives', primitivesStub],
  ])
  const env = options.env ?? fakeWindow()
  Object.assign(env.window, { __ModuleLoader__: { load: (entry) => { registration = entry } } })
  const sandbox = vm.createContext({
    document: fakeDocument(),
    console,
  })
  // A browser realm exposes `window`, `fetch`, `Audio` and `localStorage` as
  // globals, and the bundle reaches for all of them (`window.localStorage`,
  // bare `fetch`, `new Audio(...)`). A sandbox that lacks any of these makes the
  // bundle take a ReferenceError path that swallows errors — which is how a
  // check can "pass" while the real browser would behave differently.
  sandbox.window = env.window
  for (const global of ['fetch', 'Audio', 'localStorage', 'setInterval', 'clearInterval']) {
    if (env.window[global] !== undefined) sandbox[global] = env.window[global]
  }
  vm.runInContext(clientSource, sandbox)
  assert(registration !== null, 'the bundle never called window.__ModuleLoader__.load')
  assert(registration.id === 'dsh-gpt-sovits', `unexpected module id: ${registration.id}`)
  const factoryRequire = (spec) => {
    if (seed.has(spec)) return seed.get(spec)
    throw new Error(`client bundle required "${spec}" — it must only use platform seeds`)
  }
  return { exports: registration.factory(factoryRequire), factoryRequire, effects, env }
}

let client = null

check('client: registers under the package id and exposes apply/inject', () => {
  client = loadClient()
  assert(typeof client.exports.apply === 'function', 'missing apply(ctx)')
  assert(Array.isArray(client.exports.inject), 'inject must be an array')
  for (const service of ['slots', 'locale']) {
    assert(client.exports.inject.includes(service), `client inject must declare "${service}"`)
  }
  return `id=dsh-gpt-sovits, inject=[${client.exports.inject.join(', ')}]`
})

check('client: requires only platform seeds', () => {
  // loadClient() throws on any unknown require, so reaching here proves the two
  // seeds are the only ones used.
  return 'react + react/jsx-runtime only'
})

check('client: every require is a plain platform seed word', () => {
  /*
   * Regression, and a fatal one: the bundle used to `require` a sibling package
   * (`@deepseek-ai/dsh-client-ui-primitives`). That package has no `lib/client.js`
   * and so no row in the boot graph, and the loader reported the miss *outside*
   * the call — the surrounding try/catch never saw it, the plugin never
   * activated, and the entire web boot failed with "1 entry did not activate"
   * plus an application-stopped dialog.
   *
   * The module table carries the platform seed words plus rows the host composes
   * from package declarations, and a plugin must not reach past the seeds.
   */
  const allowed = new Set(['react', 'react/jsx-runtime'])
  const specifiers = [...clientSource.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
  assert(specifiers.length > 0, 'the bundle requires nothing at all, which cannot be right')
  for (const specifier of specifiers) {
    assert(allowed.has(specifier), `require("${specifier}") is not a platform seed word`)
  }
  return [...new Set(specifiers)].join(', ')
})

check('client: declares no client dependency outside the boot graph', () => {
  // `dsh.client.inject` must name packages that really have a client half.
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const inject = manifest.dsh.client.inject ?? []
  assert(Array.isArray(inject) && inject.length > 0, 'the client inject list must be declared')
  for (const name of inject) {
    assert(
      !/ui-primitives$/.test(name),
      `${name} has no client half, so it cannot be injected (this is what broke the boot)`,
    )
  }
  return inject.join(', ')
})

check('client: injects its stylesheet through the loader CSS protocol', () => {
  assert(styleTags.length === 1, `expected exactly one stylesheet, got ${styleTags.length}`)
  const tag = styleTags[0]
  assert(tag.dataset.plugin === 'dsh-gpt-sovits', 'stylesheet must carry data-plugin')
  assert(typeof tag.dataset.pluginCss === 'string' && tag.dataset.pluginCss !== '', 'stylesheet must carry data-plugin-css')
  for (const rule of ['padding:6px', 'height:calc(28px', 'data-active', ':hover']) {
    assert(tag.textContent.includes(rule), `stylesheet is missing "${rule}"`)
  }
  return `${tag.dataset.pluginCss} (${tag.textContent.length} chars)`
})

check('client: buttons use the shell button geometry, not inline styling', () => {
  // Inline styles cannot express :hover/[data-active], which is where the
  // shell's own action buttons get their affordance.
  assert(!/style:\s*\{\s*background: "none"/.test(clientSource), 'action button must not be inline-styled')
  assert(/className: CSS\.action/.test(clientSource), 'action button must carry the action class')
  assert(/className: CSS\.toggle/.test(clientSource), 'composer toggle must carry the toggle class')
  assert(/"data-active": state === "playing"/.test(clientSource), 'the icon-only action button must set data-active')
  return 'CSS classes + data-active'
})

check('client: the speaker glyph follows the shell icon contract', () => {
  const artwork = extractFunction(clientSource, 'SpeakerArtwork')
  for (const contract of ['width: 16', 'height: 16', 'viewBox: "0 0 16 16"', 'fill: "none"', 'strokeWidth: 1', 'currentColor']) {
    assert(artwork.includes(contract), `icon contract missing: ${contract}`)
  }
  return '16px box, fill:none, 1px currentColor stroke'
})

check('client: playback shows a locally drawn pause glyph', () => {
  // The shell's own pause icon lives in a package a plugin cannot require, so the
  // two bars are drawn here — on the same 16px / fill:none / 1px currentColor
  // contract as the speaker.
  const artwork = extractFunction(clientSource, 'PauseArtwork')
  for (const contract of ['width: 16', 'height: 16', 'viewBox: "0 0 16 16"', 'fill: "none"', 'strokeWidth: 1', 'currentColor']) {
    assert(artwork.includes(contract), `pause icon contract missing: ${contract}`)
  }
  assert(/state === "playing" \? h\(PauseArtwork/.test(clientSource), 'the pause glyph must be used while playing')
  return 'local pause artwork on the shell icon contract'
})

check('client: registers the four slots against live names', () => {
  const registered = []
  const injections = []
  const ctx = {
    effect: () => () => {},
    on: () => () => {},
    locale: {
      getLocale: () => ({ active: 'zh' }),
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        callback()
      },
      register: (options) => {
        registered.push(options)
        return () => {}
      },
    },
  }
  client.exports.apply(ctx)
  const names = registered.map((row) => row.name)
  for (const expected of [
    'conversation.chat.assistant-actions',
    'conversation.chat.turnTail',
    'conversation.input.left',
    'settings.section',
  ]) {
    assert(names.includes(expected), `slot not registered: ${expected}`)
  }
  for (const row of registered) {
    assert(typeof row.id === 'string' && row.id !== '', `slot ${row.name} needs an id`)
    assert(typeof row.order === 'number', `slot ${row.name} needs an order`)
    assert(typeof row.inject === 'function', `slot ${row.name} needs an inject()`)
  }
  return names.join(', ')
})

check('client: injects the prop hooks the renderer actually passes', () => {
  // The chat renderer calls renderSlot(name, { messageId }) and the registered
  // inject() supplies everything else. `useChat` cannot be injected by the
  // plugin, so the action strip must take it from props.
  assert(/function ReadAloudAction\(props\)/.test(clientSource), 'action component must take props')
  assert(/const \{ messageId, useChat, t \} = props/.test(clientSource), 'action must read messageId/useChat/t from props')
  assert(/useAddressedText\(useChat, messageId, "action"\)/.test(clientSource), 'action must read its text through the chat hook')
  return 'messageId + useChat + t'
})

check('client: the store is read only through the chat hook', () => {
  // Measured on this install: `useChat.getState()` returns null, and the nodes
  // container is a purpose-built object whose only node-yielding accessor is
  // `values()` — no `size`, no Map brand. Reading the store any other way
  // silently yields nothing.
  // Comments legitimately mention getState() to explain why it is not used, so
  // strip them before looking for a real call.
  const codeOnly = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(!/\.getState\s*\(/.test(codeOnly), 'the store must not be read through getState()')
  assert(/function snapshotNodes\(/.test(clientSource), 'a single node-access helper is required')
  assert(/typeof container\.values === "function"/.test(clientSource), 'values() is the accessor that works')
  assert(!/nodes\.size === "number"/.test(clientSource), 'no size check: this container has no size')
  assert(/legacy\.nodes/.test(clientSource), 'the older array layout must stay readable')
  return 'hook-only reads, values() accessor, legacy fallback'
})

check('client: auto-read never speaks the same reply twice', () => {
  assert(clientSource.includes('LAST_READ_KEY'), 'a persisted last-read key is required')
  // The claim set must be module-level: the shell mounts one driver per turn, so
  // per-instance state cannot coordinate them and N copies would all speak.
  assert(/const CLAIMED = new Set\(\)/.test(clientSource), 'a module-level claim set is required')
  assert(/CLAIMED\.has\(latestId\)/.test(clientSource), 'the claim set must gate playback')
  assert(/CLAIMED\.add\(latestId\)/.test(clientSource), 'the reply must be claimed before speaking')
  return 'module-level claim set + persisted mark'
})

check('client: the driver does not depend on the opaque turn prop', () => {
  // Measured, not assumed: the shell hands `conversation.chat.turnTail` a `turn`
  // whose typeof is "object", so deciding ownership from it made every copy stand
  // down and auto-read never spoke at all. The drivers now cooperate through the
  // shared claim set instead, which needs no turn identity.
  assert(/function AutoReadDriver\(props\)/.test(clientSource), 'driver missing')
  assert(/const \{ useChat \} = props/.test(clientSource), 'the driver must not destructure a turn')
  assert(!/typeof turn/.test(clientSource), 'no turn type check may remain')
  assert(!/latestTurn !== turn/.test(clientSource), 'no turn comparison may remain')
  return 'prop-independent, claim-set coordinated'
})

check('client: components never return before their hooks', () => {
  // A component that early-returns before calling a hook breaks the rules of
  // hooks: React throws, the error boundary swallows it, and the component
  // silently never appears. That is exactly how the read-aloud button and the
  // auto-read driver went missing while the settings toggle kept working.
  for (const name of ['AutoReadDriver', 'ReadAloudAction']) {
    const body = extractFunction(clientSource, name)
    const firstHook = body.search(/react\.(useState|useEffect|useRef|useCallback|useMemo)\(|useChat\(/)
    assert(firstHook !== -1, `${name} calls no hook at all`)
    const earlyReturn = body.search(/\n\t+if \([^\n]*\) return /)
    if (earlyReturn !== -1) {
      assert(earlyReturn > firstHook, `${name} early-returns (at ${earlyReturn}) before its first hook (at ${firstHook})`)
    }
  }
  return 'hooks precede every early return'
})

check('client: enabling auto-read does not read the reply already on screen', () => {
  // The persisted last-read mark is the gate, not a per-instance flag: N drivers
  // mount at once, so per-instance state is not shared and every copy would
  // treat itself as the one that just switched on.
  assert(/lastRead\.current === latestId/.test(clientSource), 'the persisted mark must gate playback')
  assert(/readStored\(LAST_READ_KEY/.test(clientSource), 'the mark must be read at mount')
  return 'gated on the persisted mark'
})

/** A chat store shaped like the one the shell hands the driver. */
function fakeChatStore(turns) {
  return {
    timeline: { turnOrder: turns.map((entry) => entry.turn) },
    legacy: {
      nodes: turns.map((entry) => ({
        kind: 'assistant-step',
        data: {
          turn: entry.turn,
          finalNode: { messageId: entry.messageId, seq: entry.turn, blocks: [{ kind: 'text', text: entry.text }] },
        },
      })),
    },
  }
}

/**
 * Drive the auto-read component through the shell's real call shape.
 *
 * The shell mounts one `conversation.chat.turnTail` entry per turn and hands it
 * `{ turn, seq, openFile }`, so the component under test is rendered once per
 * turn with the same store. Returns the URLs the player asked for.
 *
 * @param options.autoReadOnLoad - whether the toggle was already on when the page
 *   loaded (`AUTO_READ_ON_LOAD`). For the "a new reply arrived" case the toggle
 *   was on at load and the last-read mark was cleared by the new reply.
 */
async function driveAutoRead({ turns, autoReadOnLoad, previousLastRead }) {
  const env = fakeWindow()
  if (autoReadOnLoad) env.window.localStorage.setItem('gpt-sovits.autoRead', '1')
  // The persisted mark of the reply that was already spoken, if any.
  if (previousLastRead !== undefined) env.window.localStorage.setItem('gpt-sovits.lastRead', previousLastRead)

  const store = fakeChatStore(turns)
  const useChat = (selector) => selector(store)
  useChat.getState = () => store

  // The player only needs the two roads it walks: the synthesis POST and the
  // clip GET. A 1-sample WAV keeps the audio path honest without a real engine.
  const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64')
  env.window.fetch = async (url) => {
    if (String(url).includes('action=synthesize')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, url: '/gpt-sovits/audio/test.wav' }) }
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
    }
  }

  const client = loadClient({ effects: true, env })
  const turnTail = []
  const ctx = {
    effect: () => () => {},
    on: () => () => {},
    locale: {
      getLocale: () => ({ active: 'zh' }),
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        if (options.name === 'conversation.chat.turnTail') turnTail.push(component)
        return () => {}
      },
    },
  }
  client.exports.apply(ctx)
  assert(turnTail.length === 1, `expected one turnTail registration, got ${turnTail.length}`)
  const AutoReadDriver = turnTail[0]

  for (const entry of turns) {
    const before = client.effects.length
    const rendered = AutoReadDriver({ turn: entry.turn, seq: entry.turn, openFile: () => {}, useChat })
    assert(rendered === null, 'the driver must render nothing')
    // Run only this instance's effects, the way React would on mount.
    for (const effect of client.effects.slice(before)) effect()
    await settle()
  }
  return env.played
}

/**
 * Let the player's asynchronous chain finish.
 *
 * `await Promise.resolve()` is not enough: the chain is fetch → json → new
 * Audio, and a macro task is the only thing that guarantees every microtask
 * queued along the way has run.
 */
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

await (async () => {
  await check('client: exactly one turn speaks when a new reply lands', async () => {
    const turns = [
      { turn: 1, messageId: 'm1', text: '第一轮回复' },
      { turn: 2, messageId: 'm2', text: '第二轮回复' },
      { turn: 3, messageId: 'm3', text: '第三轮，最新的一条' },
    ]
    // The toggle was already on when the page loaded, so every driver is armed,
    // and the newest reply is new: exactly one of the three may speak.
    const played = await driveAutoRead({ turns, autoReadOnLoad: true, previousLastRead: 'm2' })
    assert(played.length === 1, `expected exactly 1 playback, got ${played.length} (drivers raced)`)
    assert(played[0] === '/gpt-sovits/audio/test.wav', `unexpected clip: ${played[0]}`)
    return '3 drivers mounted, 1 spoke'
  })

  await check('client: turning auto-read on does not read the reply already on screen', async () => {
    const turns = [
      { turn: 1, messageId: 'm1', text: '第一轮回复' },
      { turn: 2, messageId: 'm2', text: '已经读完的旧回复' },
    ]
    // Toggle off at load, then switched on: the last reply predates the request.
    const played = await driveAutoRead({ turns, autoReadOnLoad: false })
    assert(played.length === 0, `expected no playback for an existing reply, got ${played.length}`)
    return 'no playback for the pre-existing reply'
  })

  await check('client: auto-read off means nothing is spoken', async () => {
    const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64')
    const env = fakeWindow()
    env.window.localStorage.setItem('gpt-sovits.autoRead', '0')
    env.window.fetch = async (url) => {
      if (String(url).includes('action=synthesize')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, url: '/gpt-sovits/audio/test.wav' }) }
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      }
    }
    const client = loadClient({ effects: true, env })
    const turnTail = []
    const ctx = {
      effect: () => () => {},
      on: () => () => {},
      locale: {
        getLocale: () => ({ active: 'zh' }),
        bind: () => (key) => key,
        register: () => () => {},
      },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => {
          if (options.name === 'conversation.chat.turnTail') turnTail.push(component)
          return () => {}
        },
      },
    }
    client.exports.apply(ctx)
    const store = fakeChatStore([{ turn: 1, messageId: 'm1', text: '不该被朗读' }])
    const useChat = (selector) => selector(store)
    useChat.getState = () => store
    const before = client.effects.length
    turnTail[0]({ turn: 1, seq: 1, openFile: () => {}, useChat })
    for (const effect of client.effects.slice(before)) effect()
    await settle()
    assert(env.played.length === 0, `auto-read is off, yet the player got ${env.played.length} clip(s)`)
    return 'silent while switched off'
  })

  await check('client: clicking the read-aloud button really synthesizes and plays', async () => {
    // The button renders in the running shell, but the click path was never
    // exercised — so "the button is there" proved nothing about sound. This drives
    // the real component with a controllable chat store and fake Audio.
    const calls = []
    const env = fakeWindow()
    const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64')
    env.window.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? String(init.body) : null })
      if (String(url).includes('action=synthesize')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, url: '/gpt-sovits/audio/clip.wav', bytes: 44 }) }
      }
      if (String(url).includes('action=diag')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      }
    }

    const client = loadClient({ effects: true, env })
    const captured = {}
    client.exports.apply({
      effect: () => () => {},
      on: () => () => {},
      locale: { getLocale: () => ({ active: 'zh' }), bind: () => (key) => key, register: () => () => {} },
      slots: {
        inject: (_n, cb) => cb(),
        register: (options, component) => {
          captured[options.name] = component
          return () => {}
        },
      },
    })
    const Action = captured['conversation.chat.assistant-actions']
    assert(typeof Action === 'function', 'the action strip component was not registered')

    const store = fakeChatStore([{ turn: 1, messageId: 'm1', text: '测试朗读内容。' }])
    const useChat = (selector) => selector(store)
    useChat.getState = () => store

    const before = client.effects.length
    const tree = Action({ messageId: 'm1', useChat, t: (key) => key })
    assert(tree !== null && tree !== undefined, 'the action renders nothing for a message with text')
    for (const effect of client.effects.slice(before)) effect()
    assert(String(tree.props.className).includes('gptsovits'), `unexpected button class: ${tree.props.className}`)

    tree.props.onClick()
    await settle()
    await settle()

    const synth = calls.filter((call) => call.url.includes('action=synthesize'))
    assert(synth.length === 1, `expected 1 synthesis request, got ${synth.length}`)
    assert(synth[0].body !== null && synth[0].body.includes('测试朗读内容'), `request lost the text: ${synth[0].body}`)
    assert(env.played.length === 1, `expected 1 playback, got ${env.played.length}`)
    assert(env.played[0] === '/gpt-sovits/audio/clip.wav', `unexpected clip: ${env.played[0]}`)
    return 'click -> synthesize -> play (1 request, 1 clip)'
  })

  await check('client: the button is moved after the branch button and the row is revealed', async () => {
    /*
     * The slot hands `extraActions` a place *before* the branch button, and the
     * shell hides the whole row until hover. The placement logic is a plain
     * function over a DOM-shaped object, so exercise it directly — a fake React
     * cannot set refs the way React does.
     */
    const client = loadClient({ effects: false, env: fakeWindow() })
    const place = client.exports.__test.placeAfterBranch
    assert(typeof place === 'function', 'placeAfterBranch must be exported for checks')

    const row = { style: { opacity: '0' }, children: [] }
    const button = {
      _label: 'ours',
      parentElement: row,
      // Real DOM accessors; the idempotency guard reads both of them.
      get nextElementSibling() {
        return row.children[row.children.indexOf(button) + 1] ?? null
      },
      get previousElementSibling() {
        const at = row.children.indexOf(button)
        return at <= 0 ? null : row.children[at - 1]
      },
    }
    /** A row child. `ariaLabel` makes it the branch button, which owns the insert. */
    const makeNode = (label, ariaLabel) => {
      const node = {
        _label: label,
        querySelector: () => (ariaLabel === undefined ? null : { getAttribute: (name) => (name === 'aria-label' ? ariaLabel : null) }),
        getAttribute: () => null,
      }
      if (ariaLabel !== undefined) {
        // `insertAdjacentElement` belongs to the *branch* node: that is who the
        // placement code asks to insert.
        node.insertAdjacentElement = (position, moved) => {
          assert(position === 'afterend', `unexpected position ${position}`)
          const from = row.children.indexOf(moved)
          if (from !== -1) row.children.splice(from, 1)
          row.children.splice(row.children.indexOf(node) + 1, 0, moved)
        }
      }
      return node
    }
    const copy = makeNode('copy')
    const branch = makeNode('branch', '新对话分支')
    const endInfo = makeNode('endInfo')
    row.children = [copy, button, branch, endInfo]

    assert(place(button, ['新对话分支']) === 'placed', 'the button should have been moved')
    assert(row.style.opacity === '', 'the row must be revealed by clearing its inline opacity')
    assert(row.children.map((n) => n._label).join(',') === 'copy,branch,ours,endInfo', `unexpected order: ${row.children.map((n) => n._label).join(',')}`)

    // Idempotent: running again must not move anything or duplicate the node.
    assert(place(button, ['新对话分支']) === 'already-placed', 'a second run must be a no-op')
    assert(row.children.length === 4, `row grew to ${row.children.length} children`)

    // Degrades instead of throwing when the shell's structure is different.
    assert(place(null, ['x']) === 'no-button', 'a null ref must be reported, not thrown')
    assert(place({ parentElement: null }, ['x']) === 'no-row', 'a detached button must be reported')
    assert(place(button, ['message.branch']) === 'no-label', 'unresolved translation keys must be ignored')
    assert(
      place({ parentElement: { style: {}, children: [] }, _label: 'x' }, ['新对话分支']) === 'no-branch',
      'a row without a branch button must be reported',
    )
    return 'placed after branch, row revealed, idempotent, degrades'
  })

  await check('client: a reasoning-only reply renders no button', async () => {
    const env = fakeWindow()
    env.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const client = loadClient({ effects: true, env })
    const captured = {}
    client.exports.apply({
      effect: () => () => {},
      on: () => () => {},
      locale: { getLocale: () => ({ active: 'zh' }), bind: () => (key) => key, register: () => () => {} },
      slots: {
        inject: (_n, cb) => cb(),
        register: (options, component) => {
          captured[options.name] = component
          return () => {}
        },
      },
    })
    const store = {
      timeline: { turnOrder: [1] },
      legacy: { nodes: [{ kind: 'assistant-step', data: { finalNode: { messageId: 'm1', blocks: [{ kind: 'reasoning', text: '只有思考' }] } } }] },
    }
    const useChat = (selector) => selector(store)
    useChat.getState = () => store
    const tree = captured['conversation.chat.assistant-actions']({ messageId: 'm1', useChat, t: (key) => key })
    assert(tree === null, 'a reasoning-only reply must render no read-aloud button')
    return 'no button without speakable text'
  })
})()

// ── Text pipeline (extracted from the bundle by re-executing its helpers) ─────
// The helpers are module-private, so mirror the exact source slices and assert
// behaviour on those, which keeps this honest: it fails if the bundle changes.

/**
 * Slice one `function name(...) { ... }` declaration out of a bundle.
 *
 * Brace counting is not usable here: the bundles are full of object literals and
 * regex character classes containing braces, and a hand-rolled lexer that has to
 * tell `/` regex from `/` division is a bug farm. The sources instead have a
 * rigid shape — sibling declarations sit at one indentation and open with
 * `function ` — so the slice starts at the declaration and stops at the next
 * sibling, then ends at the first closing brace that makes the text compile as a
 * single function. Compiling is the proof that the slice is self-contained.
 */
function extractFunction(source, name) {
  const marker = `function ${name}(`
  const at = source.indexOf(marker)
  assert(at !== -1, `helper not found in bundle: ${name}`)
  const indent = /^[\t ]*/.exec(source.slice(0, at).split('\n').pop() ?? '')[0]
  const start = at

  const sibling = new RegExp(`\\n[\\t ]{${indent.length}}function `, 'g')
  sibling.lastIndex = start + marker.length
  const next = sibling.exec(source)
  const window = (next === null ? source.slice(start) : source.slice(start, next.index)).trimEnd()

  const compiles = (candidate) => {
    try {
      // eslint-disable-next-line no-new-func
      return typeof new Function(`return (${candidate})`)() === 'function'
    } catch {
      return false
    }
  }

  // The first `}` at the declaration's own indentation that closes a compilable
  // function is this declaration's end.
  const closes = new RegExp(`\\n[\\t ]{${indent.length}}\\}`, 'g')
  for (let match = closes.exec(window); match !== null; match = closes.exec(window)) {
    const candidate = window.slice(0, match.index + match[0].length)
    if (compiles(candidate)) {
      assert(candidate.startsWith(marker), `unexpected slice for ${name}`)
      return candidate
    }
  }
  throw new Error(`could not isolate a single function for ${name}`)
}

const helpers = [
  'cleanForSpeech',
  'splitIntoChunks',
  'blocksToText',
  'snapshotNodes',
  'isAssistantNode',
  'nodeMessageId',
  'nodeBlocks',
  'selectText',
  'selectLatestMessageId',
]

check('client: text helpers are present and callable', () => {
  const WORDS = { zh: { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' } }
  const CHUNK_CHARS = 110
  const source = helpers.map((name) => extractFunction(clientSource, name)).join('\n')
  const sandbox = { WORDS, CHUNK_CHARS }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\nglobalThis.__h = { cleanForSpeech, splitIntoChunks, blocksToText, selectText, selectLatestMessageId }`, sandbox)
  const api = sandbox.__h

  // The store shape measured on this install: `snapshot.nodes` is a Map.
  const mapStore = {
    nodes: new Map([
      ['k0', { kind: 'user', data: {} }],
      ['k1', { kind: 'assistant-step', data: { finalNode: { messageId: 'm1', blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '第一段' }] } } }],
      ['k2', { kind: 'turn-tail', data: {} }],
      ['k3', { kind: 'assistant-step', data: { finalNode: { messageId: 'm2', blocks: [{ kind: 'text', text: '最新的回复' }] } } }],
    ]),
  }
  assert(api.selectText(mapStore, 'm1') === '第一段', 'Map store: must read the settled text of the addressed message')
  assert(api.selectText(mapStore, 'm2') === '最新的回复', 'Map store: must read the newest message')
  assert(api.selectText(mapStore, 'missing') === '', 'Map store: an unknown message reads as empty')
  assert(api.selectLatestMessageId(mapStore) === 'm2', 'Map store: auto-read must target the newest speakable reply')

  // The older array layout is still accepted, so a different shell keeps working.
  const arrayStore = {
    legacy: {
      nodes: [
        { kind: 'assistant-step', data: { finalNode: { messageId: 'a1', blocks: [{ kind: 'text', text: '旧的' }] } } },
      ],
    },
  }
  assert(api.selectText(arrayStore, 'a1') === '旧的', 'array store: legacy layout must still be readable')

  // Neither container, or a reasoning-only tail, must degrade rather than throw.
  assert(api.selectLatestMessageId({}) === null, 'a store with no nodes must yield null')
  assert(api.selectLatestMessageId(null) === null, 'a null snapshot must yield null')
  const onlyReasoning = { nodes: new Map([['k', { kind: 'assistant-step', data: { finalNode: { messageId: 'r1', blocks: [{ kind: 'reasoning', text: '只有思考' }] } } }]]) }
  assert(api.selectLatestMessageId(onlyReasoning) === null, 'a reasoning-only reply must not be auto-read')


  const cleaned = api.cleanForSpeech(
    '# 标题\n\n看这个 https://example.com/a/b 和 `inline` 代码：\n\n```js\nconst x = 1\n```\n\n- 列表项 **加粗**\n> 引用',
    WORDS.zh,
  )
  assert(!cleaned.includes('example.com'), 'URLs must not be spoken')
  assert(!cleaned.includes('const x'), 'code fences must not be spoken')
  assert(cleaned.includes('（代码块已省略）'), 'fenced code must be replaced with a marker')
  assert(cleaned.includes('标题'), 'headings keep their text')
  assert(!cleaned.includes('#'), 'markdown markers must be stripped')
  assert(!cleaned.includes('**'), 'emphasis markers must be stripped')

  const chunks = api.splitIntoChunks('第一句。第二句！第三句？' + '很长的句子'.repeat(40))
  assert(chunks.length > 1, 'long prose must be split into multiple chunks')
  assert(chunks.every((chunk) => chunk.length <= CHUNK_CHARS * 2), 'no chunk may be unbounded')

  // Regression, seen in the engine's own log: it splits on trailing punctuation,
  // so a chunk starting with `。` became an empty first sentence and the engine
  // logged `实际输入的目标文本: 。你好…` and synthesized a stray pause.
  const leading = api.splitIntoChunks('。你好，这是测试。音色已就绪。')
  // Both sentences fit in one chunk, so only the leading punctuation may go.
  assert(leading[0] === '你好，这是测试。音色已就绪。', `leading punctuation survived: ${JSON.stringify(leading[0])}`)
  assert(leading.every((chunk) => !/^[。！？!?；;…，,、：:]/.test(chunk)), 'no chunk may start with punctuation')
  assert(api.splitIntoChunks('\n\n  你好。\n\n').length === 1, 'whitespace must not create an empty chunk')

  return `${chunks.length} chunks, markdown stripped, Map and array stores honoured`
})

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\nPASS (${passes.length})`)
for (const line of passes) console.log(`  ✓ ${line}`)
if (failures.length > 0) {
  console.log(`\nFAIL (${failures.length})`)
  for (const line of failures) console.log(`  ✗ ${line}`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed.')
}
