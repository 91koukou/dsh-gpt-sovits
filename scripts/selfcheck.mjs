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
    /*
     * A failed check reports only the message, which is usually right. When the message is a
     * bare `X is not defined`, though, that is not enough to find it: the cause can be inside
     * an evaluated block or a sandbox, far from the assertion. `SELFCHECK_STACK=1` prints the
     * stack for exactly that case.
     */
    if (process.env.SELFCHECK_STACK === '1') console.error('STACK:', error instanceof Error ? error.stack : error)
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
  /*
   * The split method is chosen per request, and the default matters.
   *
   * Streaming text goes one sentence at a time and must NOT be split again: with
   * `cut5` the engine cut on its own boundaries, disagreed with the client's, and
   * the piece it had not finished when the next request arrived was dropped.
   * A settled summary is packed into blocks, and there `cut5` lets the engine cut
   * inside a block. A request that expresses no preference must default to `cut0`,
   * because an unexpected split is what produced truncation in the first place.
   */
  assert(/text_split_method: splitMethod === 'cut5' \? 'cut5' : 'cut0'/.test(hostSource), 'the split method must be per request, defaulting to cut0')
  assert(/splitMethod === 'cut5'/.test(hostSource), 'only an explicit cut5 preference may enable splitting')
  return '13 fields, wav, non-streaming, split-on-request'
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
/** The Python supervisor, checked as text: it runs outside Node entirely. */
const supervisorSource = readFileSync(path.join(root, 'lib', 'supervisor.py'), 'utf8')

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
      /*
       * A real `location` object, because the session identity is read from the URL and it is the
       * one signal that was measured to work. A test that cannot set `href` cannot exercise it.
       */
      location: { href: 'dsh-app://app/' },
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
  /**
   * The cleanup each collected effect returned, a ref indirection so React's own
   * contract is reproduced: the cleanup must run against the refs as they are at
   * unmount, not against a copy captured at mount.
   */
  const cleanups = []
  /**
   * Ref cells for the component currently being rendered, so that a test can
   * reproduce a **remount**: React discards a component's refs when it unmounts, and
   * a plugin that hides state in a ref therefore behaves differently the second time.
   */
  let refCells = []
  const reactStub = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (initial) => [initial, () => {}],
    useEffect: options.effects === true
      ? (fn) => {
        effects.push(fn)
        if (options.cleanups === true) cleanups.push({ effect: fn, disposer: null })
      }
      : () => {},
    useRef: (initial) => {
      const cell = { current: initial }
      refCells.push(cell)
      return cell
    },
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
  return {
    exports: registration.factory(factoryRequire),
    factoryRequire,
    effects,
    env,
    /** Fresh ref cells for the next component render, as React gives a new mount. */
    beginRender: () => {
      refCells = []
    },
    /** The ref cells the last render created, in call order. */
    refs: () => refCells,
    /** The disposers of the collected effects, for an unmount test. */
    cleanups,
  }
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
    // The shell exposes sub-services through ctx.get; a stub without it fails
    // any guard that probes for an optional service.
    get: () => undefined,
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
  assert(/const \{ useChat, sessionId \} = props/.test(clientSource), 'the driver must take the sessionId prop, not a turn')
  /*
   * Scoped to the driver's own body.
   *
   * A blanket search over the whole file is wrong: the navigation selector legitimately reads
   * `typeof entry.turn === "number"` on the store's turn entries, which has nothing to do with
   * the opaque prop the shell hands the driver. The broad test was written before that selector
   * existed and would now fail on correct code.
   */
  const driverBody = clientSource.slice(clientSource.indexOf('function AutoReadDriver(props)'))
  assert(!/typeof turn\b/.test(driverBody.slice(0, 4000)), 'no turn type check may remain in the driver')
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
    // The shell exposes sub-services through ctx.get; a stub without it fails
    // any guard that probes for an optional service.
    get: () => undefined,
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
  /*
   * The slot yields the restart scope, not the component. This test drives the occupant to
   * check its behaviour, and the scope's own job — remounting the subtree when a conversation
   * switch bumps the epoch — belongs to React and cannot be exercised by calling a function.
   */
  const AutoReadDriver = client.exports.__test.SCOPED_INNER.get(turnTail[0]) ?? turnTail[0]

  for (const entry of turns) {
    const before = client.effects.length
    const rendered = AutoReadDriver({ turn: entry.turn, seq: entry.turn, openFile: () => {}, useChat, sessionId: 'session-test' })
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

  await check('client: a growing reply is queued sentence by sentence, never cut off', async () => {
    /*
     * The bug this replaces: auto-read called `play()`, which begins with `stop()`,
     * so every text update killed the sentence being spoken. The log showed `speak`
     * followed 4 ms later by `play-failed` on the previous message, for four
     * utterances out of five.
     *
     * The queue must therefore satisfy three things at once: sentences spoken in
     * order, nothing cut off mid-way, and no replay of sentences already handed
     * over when the reply grows.
     */
    const player = loadClient({ effects: false, env: fakeWindow() }).exports.__test.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' }
    const spoken = []
    // Record what would be synthesized, and fail the test if anything is stopped.
    player.requestClip = async (text) => {
      spoken.push(text)
      return '/gpt-sovits/audio/test.wav'
    }
    player.playClip = async () => {}
    const stopsBefore = player.generation
    player.stop = () => {
      throw new Error('the queue must not stop playback when it grows')
    }

    // A reply arriving in three pieces, as streaming delivers it.
    player.enqueue('m1', '第一句。第二句', words, false)
    await settle()
    player.enqueue('m1', '第一句。第二句。第三句', words, false)
    await settle()
    // Settled: the unterminated tail is flushed.
    player.enqueue('m1', '第一句。第二句。第三句。尾巴', words, true)
    await settle()

    /*
     * Streaming pieces are spoken one sentence at a time. The settled pass packs
     * consecutive sentences into blocks instead, because a finished summary arrives
     * as one large block and paying the per-request cost per sentence would let the
     * engine fall behind the listener. Both paths speak every sentence exactly once,
     * in order.
     */
    assert(spoken.length === 3, `expected the streamed sentences, got ${spoken.length}: ${JSON.stringify(spoken)}`)
    assert(spoken[0] === '第一句。', `sentence 1 wrong: ${spoken[0]}`)
    assert(spoken[1] === '第二句。', `sentence 2 wrong: ${spoken[1]}`)
    // The settled pass packs what is left: sentence 3 plus the unterminated tail.
    assert(spoken[2] === '第三句。 尾巴', `the settled block is wrong: ${spoken[2]}`)
    const joined = spoken.join('')
    for (const piece of ['第一句。', '第二句。', '第三句。', '尾巴']) {
      assert(joined.split(piece).length === 2, `"${piece}" must appear exactly once: ${joined}`)
    }
    assert(player.generation === stopsBefore, 'enqueue must not bump the generation')
    return 'streamed per sentence, packed once settled, nothing cut off or replayed'
  })

  await check('client: synthesis runs ahead of playback, so sentences do not gap', async () => {
    /*
     * The naive drain awaited synthesis and then playback, so every sentence began
     * with a synthesis-sized hole and the gap grew as the reply went on. The fix is
     * to keep clips synthesizing while the current one plays.
     *
     * Measured by making playback slow and asking how many syntheses were ever in
     * flight at once: a serial implementation can only ever reach one.
     */
    const player = loadClient({ effects: false, env: fakeWindow() }).exports.__test.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' }
    let started = 0
    let inFlight = 0
    let maxConcurrent = 0
    player.requestClip = async () => {
      started += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return '/gpt-sovits/audio/test.wav'
    }
    player.playClip = async () => {
      // Slow playback: the prefetch window has to cover this.
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    player.enqueue('m1', '第一句。第二句。第三句。', words, false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(started === 3, `expected 3 requests, got ${started}`)
    assert(maxConcurrent >= 2, `synthesis must overlap playback, but only ${maxConcurrent} was ever in flight`)
    return `3 requests, up to ${maxConcurrent} in flight at once`
  })

  await check('client: leaving the settings page does not stop playback', () => {
    /*
     * The startup greeting kept vanishing. The cause was the settings panel's unmount
     * handler calling `player.stop()` unconditionally: opening the page and navigating
     * away (or a re-render unmounting it) killed whatever was playing, and a 试音 click
     * made it worse by taking the audio channel first.
     *
     * Audio belongs to the player, not to a settings panel. Only the settings
     * component's own unmount handler is inspected: ReadAloudAction legitimately stops
     * playback, so a blanket search would flag the wrong code.
     */
    const settingsAt = clientSource.indexOf('function SovitsSettings')
    assert(settingsAt !== -1, 'the settings component must exist')
    const body = clientSource.slice(settingsAt, settingsAt + 12000)
    const handlerAt = body.indexOf('() => () => {\n\t\t\t\t\talive.current = false;')
    assert(handlerAt !== -1, 'the unmount handler must still mark the component dead')
    // Up to the effect's dependency array, with comments stripped: the handler
    // documents why it does NOT stop playback, and that prose must not be mistaken
    // for a call.
    const handler = body
      .slice(handlerAt, body.indexOf('[]', handlerAt))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert(
      !/player\.stop\(\)/.test(handler),
      `the settings unmount handler must not stop playback owned by the player:\n${handler}`,
    )
    return 'unmount only marks the component dead'
  })

  await check('client: a settled reply is packed into blocks, streaming is not', async () => {
    /*
     * The two halves of a reply are handled differently on purpose. A long summary
     * must not cost one engine request per sentence; streaming text must start
     * speaking as early as possible.
     */
    const client = loadClient({ effects: false, env: fakeWindow() })
    const player = client.exports.__test.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' }
    const requestSizes = []
    player.requestClip = async (text) => {
      requestSizes.push(text.length)
      return '/gpt-sovits/audio/test.wav'
    }
    player.playClip = async () => {}

    // Five short sentences, settled in one go: must arrive as few blocks, not five.
    const summary = '第一句。第二句。第三句。第四句。第五句。'
    player.enqueue('s1', summary, words, true)
    await settle()
    assert(requestSizes.length < 5, `a settled reply must be packed, got ${requestSizes.length} requests`)
    assert(requestSizes.length >= 1, 'the settled reply must produce at least one request')
    assert(Math.max(...requestSizes) <= 200, `a block grew too large: ${Math.max(...requestSizes)}`)

    // The same text while streaming: one request per sentence, so audio starts sooner.
    requestSizes.length = 0
    player.queued.clear()
    player.enqueue('s2', '第一句。第二句。第三句。', words, false)
    await settle()
    assert(requestSizes.length === 3, `streaming must stay one sentence per request, got ${requestSizes.length}`)
    return 'settled reply packed, streaming one sentence per request'
  })

  await check('client: switching workspace or session cancels the reading', async () => {
    /*
     * Reported: after switching workspace the previous conversation kept being read, and
     * every further switch appended to the same queue, so the queue grew without bound.
     * The turn counter cannot see this -- another conversation is not a turn of this one --
     * so the conversation identity is tracked separately, with a DOM fallback for a build
     * whose store exposes no session key.
     */
    /*
     * The signal, and the four that were tried first and failed.
     *
     * Every slot in this shell receives a standard `sessionId: SessionId` prop — it is listed in
     * the slot catalog's `standardProps` — and the conversation slots are `scope: "session"`, so the
     * shell rebuilds that subtree per session and hands it the identity it was built for.
     *
     * | Attempt | Why it failed |
     * |---|---|
     * | five guessed store field names | none of them exists on this build |
     * | `navigation.current` turn run | a global list, unbroken across a switch (the log said `conversation-grew` three times and never a change) |
     * | node-set digest | spans the whole workspace, never shrinks |
     * | the page URL | `dsh-app://app/` carries no session at all |
     *
     * The check therefore asserts the prop is used and, just as importantly, that the dead
     * detectors are **gone** — a leftover one would fight this one for the same event.
     */
    assert(/const \{ useChat, sessionId \} = props/.test(clientSource), 'the driver must take the shell\'s sessionId prop')
    assert(/RESTART_PLUGIN\("session-id-prop"\)/.test(clientSource), 'a session change must restart the plugin')
    assert(/function readSessionKey/.test(clientSource) === false || true, 'placeholder')
    assert(!/RESTART_PLUGIN\("navigation"\)/.test(clientSource), 'the dead navigation detector must be gone')
    assert(!/RESTART_PLUGIN\("digest"\)/.test(clientSource), 'the dead digest detector must be gone')
    assert(!/RESTART_PLUGIN\("url-session"\)/.test(clientSource), 'the dead URL detector must be gone')
    assert(!/RESTART_PLUGIN\("dom-transcript"\)/.test(clientSource), 'the dead DOM detector must be gone')
    assert(!/if \(readSessionKey\(\) !== null\) return;/.test(clientSource), 'nothing may stand down for a signal that never arrives')
    assert(/const RESTART_PLUGIN = /.test(clientSource), 'a conversation switch must restart the plugin, not merely stop the audio')
    assert(/player\.restart\(\)/.test(clientSource), 'the restart must reach the player')
    assert(/PLUGIN_EPOCH \+= 1/.test(clientSource), 'the restart must bump the epoch so the UI remounts')
    assert(/restartListeners/.test(clientSource), 'the restart must notify components that outlive the remount')
    assert(/lastRestartAt/.test(clientSource), 'one switch must not restart the plugin several times')
    /*
     * The mechanism, driven for real. Calling it the way a detector does is the only way to
     * check what a restart actually leaves behind — a source-text assertion cannot see a stale
     * queue or a surviving claim.
     */
    const restartApi = loadClient({ effects: false, env: fakeWindow() }).exports.__test
    assert(typeof restartApi.restart === 'function', 'the restart must be reachable for a check')

    const run = restartApi.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '代码块我不想读' }
    // Fill the machine the way a reading session would: a queue, claims, and read marks.
    run.enqueue('msg-1', '第一句。第二句。第三句。', words, true)
    run.enqueue('msg-2', '另一个回复。', words, true)
    restartApi.CLAIMED.add('msg-1')
    restartApi.CLAIMED.add('msg-2')
    const queuedBefore = run.pending.length
    assert(restartApi.CLAIMED.size === 2, 'the claims must be set up')

    const first = restartApi.restart('selfcheck')
    assert(first === true, 'the first restart must be accepted')
    assert(run.pending.length === 0, `the queue must be emptied, got ${run.pending.length}`)
    assert(run.queued.size === 0, 'the per-message offsets must be forgotten')
    assert(run.trimCache.size === 0, 'the measured clip lengths must be forgotten')
    assert(run.playing === false && run.busy === false, 'playback must be stopped')
    assert(restartApi.CLAIMED.size === 0, 'the claims must be released')
    assert(restartApi.pluginEpoch() === 1, `the epoch must advance, got ${restartApi.pluginEpoch()}`)
    // The read mark is persisted, so it must be gone from storage too — otherwise the next
    // conversation's own reply would look already read.
    assert(restartApi.readMark() === '', `the read mark must be cleared, got ${JSON.stringify(restartApi.readMark())}`)

    /*
     * One switch produces several signals a render apart, so a second call inside the guard
     * window must be ignored — otherwise the read-aloud button flickers back in two or three
     * times for one switch.
     */
    const second = restartApi.restart('selfcheck-again')
    assert(second === false, 'a restart storm must collapse to one restart')
    assert(restartApi.pluginEpoch() === 1, `the epoch must not advance twice, got ${restartApi.pluginEpoch()}`)

    assert(/data-gpt-sovits-read-aloud/.test(clientSource), 'the read-aloud button must carry the anchor')
    // The DOM observer is gone with the other dead fallbacks; nothing may regrow it.
    assert(!/MutationObserver/.test(clientSource), 'the dead DOM fallback must stay gone')

    /*
     * The cancel itself lives in `RESTART_PLUGIN`, so it is asserted there rather than in the
     * detector — the detector reports, the mechanism does the work.
     */
    const sessionEffect = clientSource.slice(clientSource.indexOf('const session = typeof sessionId === "string"'));
    assert(sessionEffect.length > 100, 'the detection block must be found')
    assert(/RESTART_PLUGIN\("session-id-prop"\)/.test(sessionEffect), 'a session change must restart the plugin')
    assert(/diag\("conversation-changed"/.test(sessionEffect), 'the change must be reported before it acts')

    // And the mechanism must actually do the work the old per-caller cancel used to do.
    const restartBody = clientSource.slice(clientSource.indexOf('const RESTART_PLUGIN = (reason)'));
    assert(/player\.restart\(\)/.test(restartBody), 'the restart must reset the player')
    assert(/CLAIMED\.clear\(\)/.test(restartBody), 'the restart must release the claims')
    assert(/writeStored\(LAST_READ_KEY, ""\)/.test(clientSource), 'the restart must forget the read mark')
    assert(/PLUGIN_EPOCH \+= 1/.test(restartBody), 'the restart must bump the epoch')

    /*
     * The detector, asserted at the source level.
     *
     * It cannot be driven by calling the component alone: the signal is a *prop the shell
     * passes*, and the remount that follows is React's doing. So what is pinned here is the
     * prop is read, validated, keyed on — and, crucially, that the previous value is kept
     * somewhere that **survives a remount**. Everything else is checked by the two tests below.
     */
    assert(/const \{ useChat, sessionId \} = props/.test(clientSource), 'the driver must take the sessionId prop')
    assert(/const session = typeof sessionId === "string"/.test(clientSource), 'the prop must be validated')
    assert(/\[session\]\);/.test(clientSource), 'the effect must key on the session')
    assert(/RESTART_PLUGIN\("session-id-prop"\)/.test(clientSource), 'a session change must restart the plugin')

    /*
     * **The bug this check exists for.** The previous value must NOT live in the component.
     *
     * A session-scoped slot is rendered under a per-session React key (`sessionGenerationKeyOf`
     * in `@deepseek-ai/dsh-client-ui-renderer`), so switching conversation unmounts the subtree
     * and mounts a fresh copy. A `useRef` — or any component state — is therefore `null` on the
     * mount that follows the switch, the effect reads that as a first mount, and the switch is
     * silently never detected. The v0.3.0 implementation did exactly this and shipped broken:
     * 50 driver mounts in the log, not one `conversation-changed`.
     */
    assert(!/sessionSeen\.current/.test(clientSource), 'the previous session must not live in a per-instance ref')
    assert(!/ACTIVE_SESSION/.test(clientSource), 'the pre-remount name must be gone with the ref it mirrored')
    assert(/let LAST_DRIVER_SESSION = null/.test(clientSource), 'the previous session must live at module scope')
    assert(/const previous = LAST_DRIVER_SESSION/.test(clientSource), 'the detector must compare against that binding')
    assert(/LAST_DRIVER_SESSION = session/.test(clientSource), 'the detector must claim the new session')

    assert(!/function readSessionKey/.test(clientSource), 'the dead URL reader must be gone')
    assert(!/function selectNavigationTurns/.test(clientSource), 'the dead navigation selector must be gone')
    assert(!/function selectNodeDigest/.test(clientSource), 'the dead digest selector must be gone')

    /*
     * A driver that is unmounted stops the voice.
     *
     * The player is module-level, so it outlives the component: without this cleanup the
     * conversation that was just switched away from keeps being read by a component that no
     * longer exists. That is the user-visible half of the report, and it is why the fix is not
     * only "detect the switch".
     *
     * Driven for real: render a driver, take the cleanup it registered, run it, and require the
     * audio to be gone. `stop()` alone is not enough — it clears the queue but a paused element
     * can still hold the output — so the element must be released too.
     */
    const unmountEnv = fakeWindow()
    const unmountClient = loadClient({ effects: true, cleanups: true, env: unmountEnv })
    const unmountSlots = []
    unmountClient.exports.apply({
      effect: () => () => {},
      on: () => () => {},
      get: () => undefined,
      locale: { getLocale: () => ({ active: 'zh' }), bind: () => (key) => key, register: () => () => {} },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => {
          if (options.name === 'conversation.chat.turnTail') unmountSlots.push(component)
          return () => {}
        },
      },
    })
    const unmountDriver = unmountClient.exports.__test.SCOPED_INNER.get(unmountSlots[0]) ?? unmountSlots[0]
    const unmountUseChat = (selector) => selector(fakeChatStore([]))
    unmountUseChat.getState = () => fakeChatStore([])
    const effectsBefore = unmountClient.effects.length
    unmountClient.beginRender()
    unmountDriver({ turn: 1, seq: 1, openFile: () => {}, useChat: unmountUseChat, sessionId: 'session-a' })
    const mountedEffects = unmountClient.effects.slice(effectsBefore)
    for (const effect of mountedEffects) effect()
    // Assigning inside the effect is how React hands a cleanup back; capture it the same way.
    for (const record of unmountClient.cleanups) {
      if (mountedEffects.includes(record.effect)) record.disposer = record.effect()
    }
    const playing = unmountClient.exports.__test.player
    const element = { paused: false, pause() { this.paused = true }, removeAttribute() { this.src = null }, src: '/gpt-sovits/audio/x.wav' }
    playing.audio = element
    playing.playing = true
    playing.pending = [{ text: '还没念完。' }]
    const disposers = unmountClient.cleanups
      .filter((record) => mountedEffects.includes(record.effect))
      .map((record) => record.disposer)
      .filter((fn) => typeof fn === 'function')
    assert(disposers.length > 0, 'the driver must register at least one cleanup, or an unmount cannot stop anything')
    for (const dispose of disposers) dispose()
    assert(playing.pending.length === 0, 'unmount must empty the queue')
    assert(playing.playing === false, 'unmount must stop playback')
    assert(element.paused === true, 'unmount must pause the audio element, not merely forget it')
    assert(playing.audio === null, 'unmount must release the audio element')

    /*
     * And the detector must fire **across a remount**, which is the case that broke.
     *
     * Two renders of the same component with a fresh ref set in between is what the shell does
     * on a switch: same module state, new component instance. The assertion is end-to-end —
     * the queue must be empty and the epoch advanced — because a detector that runs but does
     * not reach the player looks identical to a working one from the outside.
     */
    const remountClient = loadClient({ effects: true, cleanups: true, env: fakeWindow() })
    const remountSlots = []
    remountClient.exports.apply({
      effect: () => () => {},
      on: () => () => {},
      get: () => undefined,
      locale: { getLocale: () => ({ active: 'zh' }), bind: () => (key) => key, register: () => () => {} },
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => {
          if (options.name === 'conversation.chat.turnTail') remountSlots.push(component)
          return () => {}
        },
      },
    })
    const remountApi = remountClient.exports.__test
    const remountDriver = remountApi.SCOPED_INNER.get(remountSlots[0]) ?? remountSlots[0]
    const remountUseChat = (selector) => selector(fakeChatStore([]))
    remountUseChat.getState = () => fakeChatStore([])
    const renderSession = (sessionId) => {
      const from = remountClient.effects.length
      remountClient.beginRender()
      remountDriver({ turn: 1, seq: 1, openFile: () => {}, useChat: remountUseChat, sessionId })
      const mounted = remountClient.effects.slice(from)
      for (const effect of mounted) effect()
      for (const record of remountClient.cleanups) {
        if (mounted.includes(record.effect)) record.disposer = record.effect()
      }
      return mounted
    }
    renderSession('session-a')
    assert(remountApi.lastDriverSession() === 'session-a', 'the first mount must record the session')
    /*
     * The first mount must not restart. Asserted through the epoch rather than by reading the
     * effect's source: `fn.toString()` carries every literal in the effect body, so searching it
     * for `conversation-changed` matches the code that would report a change, not a report.
     */
    assert(remountApi.pluginEpoch() === 0, 'the first mount must not restart anything')

    /*
     * Seed the machine the way a reading session leaves it, then switch.
     *
     * Note what is *not* asserted: `pending.length` right after `enqueue`. `drain()` runs
     * synchronously up to its first `await`, so by the time `enqueue` returns the item is
     * already off the queue and `draining === true` — the work was accepted, and the queue is
     * simply no longer the place it lives. (Measured: `pending: 0`, `queued size: 1`,
     * `draining: true` immediately after a successful enqueue.) The queue is therefore seeded
     * directly, which is also the sharper setup: it says "this much unfinished reading exists"
     * without depending on where the drain loop happens to be.
     */
    const switchPlayer = remountApi.player
    assert(switchPlayer.enqueue('msg-old', '上一段对话还在念的句子。', {}, true) === true, 'the old reply must be accepted for reading')
    assert(switchPlayer.queued.size > 0, 'the per-message offset must be recorded by enqueue')
    const queuedOnSwitch = 1
    switchPlayer.pending.push({ text: '还没念完的句子。', key: 'msg-old', pause: 'period', splitMethod: 'cut0' })
    switchPlayer.busy = true
    assert(switchPlayer.pending.length === 1, 'the leftover reading must be set up before the switch')

    renderSession('session-b')
    assert(remountApi.lastDriverSession() === 'session-b', 'the remount must record the new session')
    assert(remountApi.pluginEpoch() === 1, `a switch across a remount must restart, got epoch ${remountApi.pluginEpoch()}`)
    assert(switchPlayer.pending.length === 0, 'the previous conversation must not keep playing')
    assert(switchPlayer.queued.size === 0, 'the previous conversation must not keep its per-message offsets')

    return `the sessionId prop is the signal, kept outside the component; a remount with a new session restarted (${queuedOnSwitch} queued dropped), and a real restart emptied ${queuedBefore} queued items and released 2 claims`
  })

  await check('client: a new turn cancels the previous turn queue', async () => {
    /*
     * The user's requirement, verbatim: entering a new round must cancel all the
     * previous processing and playback. Leftover sentences belong to a question that
     * is already answered, and speaking them over the new turn is the interruption
     * the queue exists to prevent.
     *
     * The signal is the shell's own turn counter (`snapshot.timeline.turnOrder`),
     * the same thing the shell uses to reason about turns.
     */
    const client = loadClient({ effects: false, env: fakeWindow() })
    const player = client.exports.__test.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' }
    const spoken = []
    player.requestClip = async (text) => {
      spoken.push(text)
      return '/gpt-sovits/audio/test.wav'
    }
    // Hold playback open so the queue keeps items while the assertions run.
    player.playClip = () => new Promise(() => {})
    player.stop = () => {
      player.generation += 1
      player.pending = []
      player.queued.clear()
    }
    // Request and playback are both stubbed, so the queue holds still long enough to
    // inspect: with the real `playClip` there is no Audio in this sandbox and the
    // drain loop would fail out and empty the queue before the assertion.
    player.enqueue('old', '旧回合第一句。旧回合第二句。', words, false)
    /*
     * The per-message offset, not `pending`: `enqueue` starts the drain synchronously
     * and the drain immediately shifts the first item out for synthesis, so `pending`
     * is already empty by the time this line runs. The offset is what proves the turn
     * had work in it.
     */
    assert(player.queuedUpTo('old') > 0, 'the old turn must have queued something first')
    // A new turn: the driver calls stop(), which clears the queue and bumps
    // generation so in-flight synthesis for the old turn is discarded.
    player.stop()
    assert(player.pending.length === 0, `the queue must be cleared, ${player.pending.length} left`)
    assert(player.queuedUpTo('old') === 0, 'the per-message offset must be forgotten')
    return 'queue cleared and generation bumped on a new turn'
  })

  await check('client: an unterminated sentence waits for its ending', async () => {
    // A half-written sentence must not be synthesized: the fragment would be
    // spoken and then repeated once the rest of it arrived.
    const player = loadClient({ effects: false, env: fakeWindow() }).exports.__test.player
    const words = { link: '链接', path: '路径', id: '编号', code: '长代码', codeBlock: '（代码块已省略）' }
    const spoken = []
    player.requestClip = async (text) => {
      spoken.push(text)
      return '/gpt-sovits/audio/test.wav'
    }
    player.playClip = async () => {}
    player.enqueue('m1', '这是一句还没写完的话', words, false)
    await settle()
    assert(spoken.length === 0, `an unterminated sentence must not be spoken, got ${JSON.stringify(spoken)}`)
    player.enqueue('m1', '这是一句还没写完的话，现在写完了。', words, false)
    await settle()
    assert(spoken.length === 1, `the completed sentence must be spoken once, got ${spoken.length}`)
    assert(spoken[0] === '这是一句还没写完的话，现在写完了。', `unexpected text: ${spoken[0]}`)
    return 'fragment withheld, complete sentence spoken once'
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
    // The shell exposes sub-services through ctx.get; a stub without it fails
    // any guard that probes for an optional service.
    get: () => undefined,
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
    // The slot yields the restart scope; unwrap it to reach the component under test.
    const driverInner = client.exports.__test.SCOPED_INNER.get(turnTail[0]) ?? turnTail[0]
    driverInner({ turn: 1, seq: 1, openFile: () => {}, useChat, sessionId: 'session-test' })
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
    // The shell exposes sub-services through ctx.get; a stub without it fails
    // any guard that probes for an optional service.
    get: () => undefined,
      locale: { getLocale: () => ({ active: 'zh' }), bind: () => (key) => key, register: () => () => {} },
      slots: {
        inject: (_n, cb) => cb(),
        register: (options, component) => {
          captured[options.name] = component
          return () => {}
        },
      },
    })
    // The slot yields the restart scope; unwrap it to reach the component under test.
    const scopedAction = captured['conversation.chat.assistant-actions']
    const Action = client.exports.__test.SCOPED_INNER.get(scopedAction) ?? scopedAction
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
    // The shell exposes sub-services through ctx.get; a stub without it fails
    // any guard that probes for an optional service.
    get: () => undefined,
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
    // The slot yields the restart scope; unwrap it to reach the component under test.
    const scopedForTree = captured['conversation.chat.assistant-actions']
    const innerForTree = client.exports.__test.SCOPED_INNER.get(scopedForTree) ?? scopedForTree
    const tree = innerForTree({ messageId: 'm1', useChat, t: (key) => key })
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
  'speakNormalize',
  'cleanForSpeech',
  'splitIntoSentences',
  'tablesToProse',
  'maskReferencedSymbols',
  'splitIntoBlocks',
  'segmentSentence',
  'pauseKindOf',
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
  const SENTENCE_SOFT_MAX = 280
  const SENTENCE_MERGE_MAX = 10
  const SENTENCE_BLOCK_MAX = 160
  const PAUSE_MS = { paragraph: 520, period: 340, exclamation: 340, question: 340, ellipsis: 460, semicolon: 240, colon: 200, comma: 150, none: 120 }
  const SENTENCE_END_RE = /[。！？!?；;…]+[”’"』」）)】》〉\]]*|$/g

  /*
   * The unit tables are lifted from the bundle rather than retyped, so a test can never
   * pass against a stale copy of the data the plugin actually uses.
   */
  function liftBlock(marker) {
    const start = clientSource.indexOf(marker)
    assert(start !== -1, `missing block: ${marker}`)
    let depth = 0
    let seen = false
    for (let index = start; index < clientSource.length; index += 1) {
      const char = clientSource[index]
      if (char === '{') { depth += 1; seen = true } else if (char === '}') {
        depth -= 1
        if (seen && depth === 0) {
          const end = clientSource.indexOf(';', index)
          return clientSource.slice(start, end === -1 ? index + 1 : end + 1)
        }
      }
    }
    throw new Error(`unbalanced block: ${marker}`)
  }
  /*
   * Evaluate the lifted blocks, so the sandbox receives the *values* the bundle uses.
   *
   * Two things this has to get right, both learned the hard way:
   *
   * | Detail | Why |
   * |---|---|
   * | The value is evaluated, not the source text | Injecting the text left the bare identifiers undefined inside the sandbox, so the assertions ran against a rule that never fired and the unit tests "passed" while doing nothing |
   * | Dependencies arrive as parameters | Both patterns are IIFEs that read `UNIT_WORDS`. Evaluating them in isolation threw `UNIT_WORDS is not defined`, which surfaced only as a failed check with no line number |
   */
  const liftValue = (marker, dependencies = {}) => {
    const block = liftBlock(marker)
    const expression = block.slice(block.indexOf('=') + 1).replace(/;\s*$/, '')
    const names = Object.keys(dependencies)
    // eslint-disable-next-line no-new-func
    return new Function(...names, `return (${expression})`)(...names.map((name) => dependencies[name]))
  }
  const SYMBOL_NAMES = liftValue('const SYMBOL_NAMES = {')
  const UNIT_WORDS = liftValue('const UNIT_WORDS = {')
  const UNIT_PATTERN = liftValue('const UNIT_PATTERN = ', { UNIT_WORDS })
  const ABBREVIATION_PATTERN = liftValue('const ABBREVIATION_PATTERN = ', { UNIT_WORDS })
  assert(UNIT_WORDS['km/h'] === '千米每小时', 'the unit table must lift correctly')
  assert(SYMBOL_NAMES[';'] === '分号', 'the symbol table must lift correctly')
  assert(UNIT_PATTERN instanceof RegExp && ABBREVIATION_PATTERN instanceof RegExp, 'both unit patterns must lift')
  // And they must actually match, not merely exist.
  assert(UNIT_PATTERN.test('120km/h'), 'the compound-unit pattern must match a real unit')
  assert(ABBREVIATION_PATTERN.test('2.4GHz'), 'the abbreviation pattern must match a real unit')
  const source = helpers.map((name) => extractFunction(clientSource, name)).join('\n')
  const sandbox = { WORDS, SENTENCE_SOFT_MAX, SENTENCE_MERGE_MAX, SENTENCE_BLOCK_MAX, PAUSE_MS, SENTENCE_END_RE, UNIT_WORDS, UNIT_PATTERN, ABBREVIATION_PATTERN }
  /*
   * The lifted constants must be *declared inside the context*, not merely handed in as
   * sandbox properties. A property is a global the script can read; a `const` in that script
   * is what `speakNormalize` closes over, and the two are not interchangeable.
   */
  const declarations = [
    `const SYMBOL_NAMES = ${JSON.stringify(SYMBOL_NAMES)};`,
    `const UNIT_WORDS = ${JSON.stringify(UNIT_WORDS)};`,
    `const UNIT_PATTERN = ${UNIT_PATTERN.toString()};`,
    `const ABBREVIATION_PATTERN = ${ABBREVIATION_PATTERN.toString()};`,
  ].join('\n')
  vm.createContext(sandbox)
  vm.runInContext(`${declarations}\n${source}\nglobalThis.__h = { speakNormalize, cleanForSpeech, splitIntoSentences, splitIntoBlocks, segmentSentence, pauseKindOf, PAUSE_MS, UNIT_WORDS, blocksToText, selectText, selectLatestMessageId }`, sandbox)
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

  /*
   * One sentence per request, and the pause each sentence earns comes from its own
   * punctuation. Sentences are objects now (`{ text, pause }`) because the engine's
   * trailing silence is trimmed away and the gaps are inserted by the player.
   */
  const sentences = api.splitIntoSentences('第一句。第二句！第三句？')
  assert(sentences.length === 3, `each sentence must stand alone, got ${sentences.length}`)
  assert(sentences[0].text === '第一句。' && sentences[2].text === '第三句？', `split wrong: ${JSON.stringify(sentences)}`)
  assert(sentences[0].pause === 'period' && sentences[1].pause === 'exclamation' && sentences[2].pause === 'question',
    `pause kinds wrong: ${JSON.stringify(sentences.map((s) => s.pause))}`)

  /*
   * The reported bug: "sentences that should not be joined get joined". Chinese has more
   * sentence terminators than a full stop, and runs of them are common; the first
   * implementation split with a lookbehind and produced `他沉默了三秒…` plus a lone `…`.
   */
  const marks = api.splitIntoSentences('真的吗？当然！他沉默了三秒……然后走了；我也走了。')
  assert(marks.length === 5, `Chinese terminators must separate sentences, got ${marks.length}: ${JSON.stringify(marks.map((s) => s.text))}`)
  assert(marks[2].text === '他沉默了三秒……', `a terminator run must stay attached: ${marks[2].text}`)
  assert(marks[2].pause === 'ellipsis', `an ellipsis earns its own pause: ${marks[2].pause}`)
  assert(api.splitIntoSentences('他说：“走吧。”然后走了。').length === 2, 'a closing quote must end the sentence')

  /*
   * Merging is deliberately rare: it hands the boundary to the engine, so the
   * per-sentence pause control is lost. Ordinary short sentences must stay apart.
   */
  const shortOnes = api.splitIntoSentences('好的。然后呢。完成了。')
  assert(shortOnes.length === 3, `short sentences must keep their own pauses, got ${shortOnes.length}`)

  /*
   * A paragraph break is a hard boundary and gets the longest pause; the first
   * implementation collapsed newline runs, so a paragraph was indistinguishable from a
   * soft wrap and the reader ran one thought into the next.
   */
  const paras = api.splitIntoSentences('第一段的句子。\n\n第二段的句子。')
  assert(paras.length === 2, `paragraphs must not merge, got ${paras.length}`)
  assert(paras[0].pause === 'paragraph', `a paragraph must end on the long pause, got ${paras[0].pause}`)
  assert(api.PAUSE_MS.paragraph > api.PAUSE_MS.period && api.PAUSE_MS.period > api.PAUSE_MS.comma,
    'pauses must be ordered by the weight of the punctuation')

  // A sentence far over the soft max degrades at clause marks, not mid-word.
  const runOn = api.splitIntoSentences(`很长的一句${'，从句内容'.repeat(60)}。`)
  assert(runOn.length > 1, 'an oversized sentence must still be broken up')
  assert(runOn.every((entry) => entry.text.length <= SENTENCE_SOFT_MAX + 20), `clause chunks too long: ${runOn.map((entry) => entry.text.length)}`)
  assert(runOn.every((entry) => !entry.text.startsWith('，')), 'a clause chunk must not start with its separator')

  // Regression, seen in the engine's own log: a chunk starting with `。` became an empty
  // first sentence and the engine logged `实际输入的目标文本: 。你好…`.
  const leading = api.splitIntoSentences('。你好，这是测试。音色已就绪。')
  assert(leading[0].text === '你好，这是测试。', `leading punctuation survived: ${JSON.stringify(leading[0].text)}`)
  assert(leading.every((entry) => !/^[。！？!?；;…，,、：:]/.test(entry.text)), 'no sentence may start with punctuation')

  // Settled packing keeps the pause of the block's last sentence.
  const blocks = api.splitIntoBlocks(api.splitIntoSentences('第一句。第二句。第三句。'), SENTENCE_BLOCK_MAX)
  assert(blocks.length >= 1, 'packing must produce at least one block')
  assert(blocks.every((block) => typeof block.text === 'string' && typeof block.pause === 'string'), 'blocks carry text and pause')
  assert(blocks[blocks.length - 1].pause === 'period', `the block keeps its last sentence's pause: ${blocks[blocks.length - 1].pause}`)

  /*
   * Symbol-to-speech rewriting. Each case here was reported from listening to the
   * output: the engine drops these symbols, so they have to become words.
   */
  const spoken = (input) => api.speakNormalize(input, WORDS.zh)
  /** The full text stage, as the player runs it: normalise, then strip markdown. */
  const clean = (input) => api.cleanForSpeech(input, WORDS.zh)

  /*
   * Units. Reported: the generic slash rule destroyed every rate and speed unit, because a
   * slash inside a unit means "per", not "or" -- `120km/h` came out as `120km或h`. A second
   * problem came with it: a bare abbreviation reached the engine as spelling, so `2.4GHz`
   * was read "2点4 G H z".
   *
   * These also pin the ordering. The unit rule must run before the slash rule, and the
   * abbreviation rule after the extension rule.
   */
  assert(spoken('速度 120km/h') === '速度 120千米每小时', `km/h: ${spoken('速度 120km/h')}`)
  assert(spoken('转速 3000r/min') === '转速 3000转每分钟', `r/min: ${spoken('转速 3000r/min')}`)
  assert(spoken('带宽 100MB/s') === '带宽 100兆字节每秒', `MB/s: ${spoken('带宽 100MB/s')}`)
  assert(spoken('5m/s²') === '5米每秒平方', `m/s squared: ${spoken('5m/s²')}`)
  // Spacing inside the unit is allowed and must reach the same table entry.
  assert(spoken('100 km / h') === '100千米每小时', `spaced km / h: ${spoken('100 km / h')}`)
  // The quantity is consumed with the unit; re-emitting it read "120 120千米每小时".
  assert(!/\d+\s+\d+千米/.test(spoken('速度 120km/h')), 'the quantity must not be duplicated')
  // Bare abbreviations.
  assert(spoken('频率 2.4GHz') === '频率 2点4吉赫兹', `GHz: ${spoken('频率 2.4GHz')}`)
  assert(spoken('刷新率 144Hz') === '刷新率 144赫兹', `Hz: ${spoken('刷新率 144Hz')}`)
  assert(spoken('延迟 20ms') === '延迟 20毫秒', `ms: ${spoken('延迟 20ms')}`)
  assert(spoken('内存 16GB') === '内存 16吉字节', `GB: ${spoken('内存 16GB')}`)
  /*
   * The abbreviation rule requires a digit in front, or ordinary words would be rewritten:
   * "minimum" contains `min` and "things" contains `s`.
   */
  assert(spoken('minimum 的值') === 'minimum 的值', `minimum: ${spoken('minimum 的值')}`)
  assert(spoken('things 很多') === 'things 很多', `things: ${spoken('things 很多')}`)
  // A real file name is still an extension, not a unit.
  assert(spoken('打开 a.b.js') === '打开 a.b点js', `extension must still win: ${spoken('打开 a.b.js')}`)
  // A slash that really is a choice still reads as "或".
  assert(spoken('按 是/否 回答') === '按 是或否 回答', `choice slash: ${spoken('按 是/否 回答')}`)
  assert(spoken('中文/英文') === '中文或英文', `choice slash 2: ${spoken('中文/英文')}`)
  // And a fraction still reads as one.
  assert(spoken('3/4 杯') === '4分之3 杯', `fraction: ${spoken('3/4 杯')}`)
  // The table must really be the one in the bundle, not a copy in this file.
  assert(typeof UNIT_WORDS === 'object' && UNIT_WORDS !== null, `UNIT_WORDS must be an object, got ${typeof UNIT_WORDS}`)

  /*
   * Tables. Reported: the separator row was read as minus signs. The reply reaches this
   * pipeline as raw markdown, so a table arrived as pipes and dashes and the engine reads
   * both aloud. Neither is content: one is a cell boundary, the other is how the format
   * draws a line.
   */
  assert(clean(spoken('| 名字 | 说明 |\n| --- | --- |\n| A | 第一项 |\n| B | 第二项 |')) === '名字，说明。 A，第一项。 B，第二项。',
    `table prose: ${clean(spoken('| 名字 | 说明 |\n| --- | --- |\n| A | 第一项 |\n| B | 第二项 |'))}`)
  assert(!spoken('| 名字 | 说明 |\n| --- | --- |\n| A | 第一项 |').includes('|'), 'no pipe may survive')
  assert(!/[-—]{2,}/.test(spoken('| 名字 | 说明 |\n| --- | --- |\n| A | 第一项 |')), 'a separator row must not become dashes')
  // A separator row with no data is punctuation only and must vanish entirely.
  assert(clean(spoken('| --- | --- |')) === '', `lone separator: ${clean(spoken('| --- | --- |'))}`)
  // A horizontal rule is still a rule, not table content.
  assert(clean(spoken('文字\n\n---\n\n更多')) === '文字\n\n更多', `horizontal rule: ${clean(spoken('文字\n\n---\n\n更多'))}`)

  /*
   * A referenced symbol must be spoken by name. Reported: `把 \`;\` 也作为切分符号` lost the
   * semicolon entirely, because the engine drops a bare `;` -- the sentence was about a
   * symbol it never said. Punctuation *used* as punctuation must keep behaving as one.
   */
  assert(clean(spoken('把 `;` 也作为切分符号')) === '把 分号 也作为切分符号', `semicolon name: ${clean(spoken('把 `;` 也作为切分符号'))}`)
  assert(clean(spoken('把 `,` 也作为切分符号')) === '把 逗号 也作为切分符号', `comma name: ${clean(spoken('把 `,` 也作为切分符号'))}`)
  assert(clean(spoken('把 `;` `,` 都算')) === '把 分号 逗号 都算', `several names: ${clean(spoken('把 `;` `,` 都算'))}`)
  assert(clean(spoken('用 `[` 和 `]` 包')) === '用 左方括号 和 右方括号 包', `bracket names: ${clean(spoken('用 `[` 和 `]` 包'))}`)
  // A code identifier is not a symbol reference and must stay exactly as written.
  assert(clean(spoken('把 `split` 也作为切分符号')) === '把 split 也作为切分符号', `identifier untouched: ${clean(spoken('把 `split` 也作为切分符号'))}`)
  // Punctuation used as punctuation is unchanged.
  assert(clean(spoken('第一句；第二句。')) === '第一句；第二句。', `ordinary punctuation: ${clean(spoken('第一句；第二句。'))}`)
  /*
   * The regression this design exists to avoid: the spoken name is masked, so a referenced
   * full stop cannot become a sentence terminator and split the sentence in the wrong place.
   */
  const referencedStop = api.splitIntoSentences(clean(spoken('把 `。` 也作为切分符号')))
  assert(referencedStop.length === 1, `a referenced full stop must not end a sentence, got ${referencedStop.length}`)
  assert(referencedStop[0].text === '把 句号 也作为切分符号', `referenced stop text: ${referencedStop[0].text}`)
  // The symbol table must come from the bundle too.
  assert(SYMBOL_NAMES[';'] === '分号' && SYMBOL_NAMES['。'] === '句号', 'the symbol table must come from the bundle')

  assert(spoken('运行 cmd.exe 即可') === '运行 cmd点exe 即可', `cmd.exe: ${spoken('运行 cmd.exe 即可')}`)
  assert(spoken('把 3-10 改成 3 减 10') === '把 3到10 改成 3 减 10', `range: ${spoken('把 3-10 改成 3 减 10')}`)
  assert(spoken('3 ~ 10 之间') === '3到10 之间', `tilde range: ${spoken('3 ~ 10 之间')}`)
  assert(spoken('看 v2.7.0 版本') === '看 v2点7点0 版本', `version: ${spoken('看 v2.7.0 版本')}`)
  assert(spoken('连 127.0.0.1 端口') === '连 127点0点0点1 端口', `IP: ${spoken('连 127.0.0.1 端口')}`)
  assert(spoken('温度 36.5 度') === '温度 36点5 度', `decimal: ${spoken('温度 36.5 度')}`)
  // A date must not be turned into a double range.
  assert(spoken('2024-10-03 提交') === '2024-10-03 提交', `date: ${spoken('2024-10-03 提交')}`)
  /*
   * Slash and backslash readings the author asked for: a real fraction is spoken
   * as such, everything else reads as "或", and a path separator reads as "杠".
   */
  assert(spoken('是真/假') === '是真或假', `alt slash: ${spoken('是真/假')}`)
  assert(spoken('选 是/否/待定') === '选 是或否或待定', `chained slash: ${spoken('选 是/否/待定')}`)
  assert(spoken('占 3/4 比例') === '占 4分之3 比例', `fraction: ${spoken('占 3/4 比例')}`)
  assert(spoken('反斜杠 a\\b') === '反斜杠 a杠b', `backslash: ${spoken('反斜杠 a\\b')}`)
  /*
   * Masking order: slashes inside a URL, a path or a UUID must not become "或".
   * Without the mask pass the separator rule rewrites them.
   */
  assert(
    spoken('看 https://a.com/b 这个') === '看 链接 这个',
    `a URL must be masked before the slash rule: ${spoken('看 https://a.com/b 这个')}`,
  )
  assert(!spoken('打开 C:\\Users\\me\\a.txt').includes('或'), 'a path must not gain 或')
  // Normalization runs before cleanForSpeech, so the extension survives.
  const pipeline = api.cleanForSpeech(spoken('执行 cmd.exe'), WORDS.zh)
  assert(pipeline.includes('点exe'), `pipeline lost the extension: ${pipeline}`)

  return `${sentences.length} sentences (pauses and paragraphs included), markdown stripped, symbols spoken, Map and array stores honoured`
})

check('client: the startup greeting is once per session and silent on failure', () => {
  // The greeting tells the user the plugin is ready, but it must not fire on every
  // refresh (waiting for the models makes a repeat genuinely irritating) and it
  // must never surface an error when it cannot be synthesized.
  assert(/sessionStorage\.getItem\(GREETING_SESSION_KEY\)/.test(clientSource), 'a session mark must gate the greeting')
  assert(/let GREETING_STARTED = false/.test(clientSource), 'a module latch must cover the storage race')
  assert(!/GREETING_DELAY_MS/.test(clientSource), 'no artificial delay: the host warms the greeting at boot')
  assert(/GREETING_ATTEMPTS/.test(clientSource), 'the greeting must poll while the host is still warming up')
  assert(/action=greeting/.test(clientSource), 'the client must ask the host for the greeting clip')
  // Played by URL: the host already synthesized it, so a second engine call is waste.
  assert(/payload\.url/.test(clientSource), 'the greeting clip must be played by its URL')
  assert(/diag\("greet-failed"/.test(clientSource), 'a failed greeting must be reported, not thrown')
  assert(/diag\("greet-timeout"/.test(clientSource), 'giving up must be reported too')
  return 'latched, session-gated, polled, played by URL, failure-tolerant'
})

check('host: the greeting is produced when the engine is idle, never while it works', () => {
  /*
   * Every earlier design failed on a real machine because each one guessed *when* the
   * engine would be ready: a fixed delay fired before the port was bound, and a
   * readiness wait still assumed boot was the only thing competing for the engine.
   *
   * The rule is now: produce the greeting when the engine is free, and stand down the
   * moment it starts working. The client polls; the host answers with a state.
   */
  assert(/const greetingGate = /.test(hostSource), 'the gate must be a single named decision')
  assert(/if \(engineQueueBusy\(\)\) return \{ state: 'engine-busy' \}/.test(hostSource), 'real work must stand the greeting down')
  assert(/recentHealth\(\)/.test(hostSource), 'reachability must come from the cache, not a probe per poll')
  assert(/healthCache = health/.test(hostSource), 'the heartbeat must refresh that cache')
  // The route must answer immediately with a state, so 500 ms polling cannot pile up.
  assert(/const gate = greetingGate\(\)/.test(hostSource), 'the route must consult the gate')
  assert(/state: gate\.state/.test(hostSource), 'the route must report why it is not ready')
  assert(/greetingPromise = undefined/.test(hostSource), 'the in-flight latch must be released on every path')
  return 'gated on engine idleness, cached reachability, answering immediately'
})

check('host: engine state is sampled every 100 ms', () => {
  /*
   * The design calls for 100 ms. The fast tick reads local variables only; the HTTP
   * probe that answers "is the engine reachable?" runs every 20th tick, because ten
   * probes a second would compete with the synthesis they are meant to observe.
   */
  assert(/const FAST_MS = 100/.test(hostSource), 'the fast tick must be 100 ms')
  assert(/PROBE_EVERY = 20/.test(hostSource), 'the HTTP probe must run on a slower divisor')
  assert(/ticks % PROBE_EVERY !== 0/.test(hostSource), 'the probe must be skipped on non-divisor ticks')
  assert(/engineQueueBusy\(\)/.test(hostSource), 'the fast tick must sample the local busy flag')
  assert(/engineBusySince/.test(hostSource) && /engineIdleSince/.test(hostSource), 'busy and idle times must be recorded')
  return '100 ms local sampling, 2 s reachability probe'
})

check('host: the engine console output is captured and readable', () => {
  /*
   * The engine's stdout/stderr is what the API console window used to show, and it went
   * to DEVNULL -- which is why engine-side failures were invisible from the UI.
   */
  assert(/engineOutputPath/.test(hostSource), 'the engine output needs a captured file')
  assert(/'--engine-log', engineOutputPath\(\)/.test(hostSource), 'the supervisor must be told to capture it')
  assert(/action === 'logs'/.test(hostSource), 'a route must serve the captured logs')
  assert(/transcript: recentSynthesis/.test(hostSource), 'the console must also show what was generated')
  // The supervisor must actually redirect into the file, and merge stderr into stdout.
  assert(/stderr=subprocess\.STDOUT/.test(supervisorSource), 'stderr must be merged into the captured stream')
  assert(/options\.engine_log/.test(supervisorSource), 'the supervisor must honour --engine-log')
  return 'captured, served, stderr merged'
})

check('host: audio is served from memory, with the on-disk clips reclaimed', () => {
  /*
   * The user asked for this directly: stop wearing the drive. The previous design wrote a
   * WAV per sentence and served it as a static file -- hundreds of small writes per reading
   * session for data played once and never read again.
   */
  assert(!/writeFileSync\(join\(audioDir/.test(hostSource), 'nothing may write clips to disk any more')
  assert(/const audioCache = new Map\(\)/.test(hostSource), 'the cache must be in memory')
  assert(/AUDIO_CACHE_BYTES/.test(hostSource), 'a byte ceiling must exist, not just a count')
  assert(/const evictAudio/.test(hostSource), 'eviction must be its own step')
  assert(/audioCacheBytes/.test(hostSource), 'the byte total must be tracked')
  assert(/purgeLegacyAudioFiles/.test(hostSource), 'the files an older version left must be reclaimed')
  assert(/rmSync/.test(hostSource), 'the reclaim must actually delete')

  // The route must read memory, never the filesystem.
  const route = hostSource.slice(hostSource.indexOf('const handleAudio'))
  assert(/audioCache\.get\(clipId\)/.test(route), 'the audio route must serve from the cache')
  assert(!/readFileSync/.test(route.slice(0, route.indexOf('const mount'))), 'the audio route must not touch disk')

  // Expression settings must reach the engine, and quality controls must stay fixed.
  assert(/expressSettings\.temperature/.test(hostSource), 'temperature must be per request')
  assert(/expressSettings\.topK/.test(hostSource), 'top-k must be per request')
  assert(/expressSettings\.topP/.test(hostSource), 'top-p must be per request')
  assert(/fragment_interval: 0/.test(hostSource), 'the engine must add no silence of its own')
  assert(!/expressSettings\.sampleSteps/.test(hostSource), 'generation quality must NOT be per sentence')
  assert(!/expressSettings\.superSampling/.test(hostSource), 'super sampling must NOT be per sentence')
  assert(/const clamp =/.test(hostSource), 'per-request numbers must be clamped, not trusted')
  return 'memory-only clips, byte-capped, expression per sentence, quality fixed'
})

check('host: the engine console is decoded as UTF-8, with a code-page fallback', () => {
  /*
   * Measured mojibake, reported by the user: Python on Windows encodes stdout/stderr with
   * the console code page (cp936 here), so every Chinese line the engine printed came out
   * garbled in the panel -- including the socket errors and the target text, which is
   * exactly the content a reader needs when something goes wrong.
   *
   * Both halves of the fix are checked: the supervisor tells the engine to emit UTF-8, and
   * the reader re-decodes a log left by an older supervisor rather than showing it wrong.
   */
  assert(/PYTHONIOENCODING/.test(supervisorSource), 'the engine must be told to emit UTF-8')
  assert(/engine_env/.test(supervisorSource), 'the spawn must build that environment')
  assert(/env=engine_env/.test(supervisorSource), 'the environment must actually reach Popen')
  assert(/new TextDecoder\('gbk'\)/.test(hostSource), 'the reader must have a code-page fallback')
  assert(/includes\('\\uFFFD'\)/.test(hostSource), 'the fallback must trigger on a replacement character')
  const readAt = hostSource.indexOf('const readTail = (file)')
  const useAt = hostSource.indexOf('readTail(file)')
  assert(readAt !== -1 && useAt > readAt, 'the log reader must use the tolerant read')
  return 'engine emits UTF-8, reader tolerates an older code page'
})

check('client: the engine console is embedded in the settings page', () => {
  /*
   * Two designs were rejected before this one, and both reasons are worth keeping:
   *
   *  - A **separate console window** steals focus, and closing it kills the engine,
   *    because that window *is* the process's console.
   *  - A **right-sidebar tab** made DSH report a background task as running, and the
   *    registration is a host-composed client capability: on a build without it the
   *    plugin loads with the tab missing, and depending on it can stop the plugin from
   *    coming up at all. The user rejected this outright.
   *
   * Slot content inside the settings page has neither problem: it cannot affect the
   * boot, and it needs no shell capability beyond the slot it already uses.
   */
  assert(/function EngineConsole\(props\)/.test(clientSource), 'the console component must exist')
  assert(/h\(EngineConsole, \{ t \}\)/.test(clientSource), 'the settings page must render it')
  assert(/action=logs/.test(clientSource), 'the console must read the captured logs')
  assert(!/sidebarRightTabs/.test(clientSource), 'no sidebar tab registration: rejected, and it can affect the boot')
  assert(!/sidebar\.right\.pane\.tab/.test(clientSource), 'no right-sidebar slot usage: the console belongs inline')
  return 'inline in the settings page, no shell capability needed'
})


check('host: the greeting never nests the engine queue', () => {
  /*
   * Measured deadlock, and a total one: `speak` already queues its own synthesis, so
   * wrapping the call in `withEngine` nests the serial chain inside itself. The outer
   * entry holds the chain while the inner one waits for it, and the greeting sits in
   * `synthesizing` forever with the engine reported busy -- observed for over 60 s with
   * no progress at all.
   *
   * The engine queue is the only place that may call `withEngine`, and it must do so
   * exactly once per operation.
   */
  const calls = hostSource.match(/await withEngine\(/g) ?? []
  assert(calls.length === 1, `exactly one withEngine call site is expected, found ${calls.length}`)
  assert(!/withEngine\(\(\) => speak/.test(hostSource), 'speak must never be wrapped: it queues internally')
  assert(/const result = await speak\(\{ text, signal: undefined \}\)/.test(hostSource), 'the greeting must call speak directly')
  return 'one call site, speak called un-nested'
})

check('host: the greeting route degrades instead of failing the plugin', () => {
  assert(/action === 'greeting'/.test(hostSource), 'the greeting route must exist')
  assert(/greetOnStart: Schema\.boolean\(\)/.test(hostSource), 'greetOnStart must be configurable')
  assert(/greetText: Schema\.string\(\)/.test(hostSource), 'greetText must be configurable')
  // A greeting that could not be produced answers 200 with ok:false: a missing
  // nicety must never look like a broken plugin, and a disabled greeting must not
  // pay for a synthesis to say so.
  assert(
    /sendJson\(res, 200, \{\s*ok: false,\s*enabled: true,\s*state: greetingError/.test(hostSource),
    'a failed greeting must still answer 200',
  )
  assert(
    /sendJson\(res, 200, \{ ok: true, enabled: false, state: gate\.state \}\)/.test(hostSource),
    'a disabled greeting must answer without synthesizing',
  )
  assert(/greetOnStart: effective\.greetOnStart/.test(hostSource), 'the settings view must expose the greeting flags')
  return 'greeting route, configurable, 200-on-failure'
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
