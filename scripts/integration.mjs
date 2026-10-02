/**
 * Live integration harness for dsh-gpt-sovits' host half.
 *
 * The host half only needs `ctx.get('webServer')` and `ctx.effect`, so this
 * script stands up a real HTTP server, feeds the plugin a minimal context,
 * registers the two routes through the plugin's own code path, and then drives
 * them with real requests — including a real synthesis against a running
 * GPT-SoVITS API when one is reachable.
 *
 * By default it loads the *installed* copy from the DSH profile, because that
 * is the half that actually runs and it is the one with a resolvable
 * `node_modules` (the workspace source cannot resolve `@deepseek-ai/schemastery`
 * on its own). Pass `--source workspace` to exercise the working tree instead.
 *
 * Usage:
 *   node scripts/integration.mjs --ref <reference.wav> [--gpt <a.ckpt>] [--sovits <b.pth>]
 *                                [--text "..."] [--skip-synthesis]
 *                                [--source workspace|installed] [--server http://127.0.0.1:9880]
 *
 * `--ref` is required for the synthesis checks: no reference clip is shipped with
 * this plugin and none ever will be. Bring your own.
 */
import { createServer } from 'node:http'
import { copyFileSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : args[at + 1]
}
/**
 * Reference clip for the synthesis checks.
 *
 * Deliberately empty by default: a reference clip carries a person's voice, so
 * this repository ships none. Pass `--ref` to point at your own.
 */
const REF_AUDIO = argOf('--ref', '')
const TEXT = argOf('--text', '你好，这是通过 DeepSeek Harness 插件朗读的一句话。')
const SKIP_SYNTHESIS = args.includes('--skip-synthesis')
const SERVER_URL = argOf('--server', 'http://127.0.0.1:9880')
/** Model weights for the preset under test; relative to the engine root. */
const GPT_WEIGHTS = argOf('--gpt', '')
const SOVITS_WEIGHTS = argOf('--sovits', '')

/**
 * Pick the host half to exercise.
 *
 * The workspace copy is preferred: it is the one under development and the one
 * whose `node_modules` this harness bootstraps. The installed copy is the
 * fallback for a machine that only has the plugin installed. `--source
 * installed` is what you want to check "what the running DSH actually loaded",
 * but note the profile copy only refreshes when the files are re-synced.
 */
function resolveTarget() {
  const requested = argOf('--source', 'auto')
  const workspaceEntry = join(import.meta.dirname, '..', 'lib', 'index.js')
  const installedEntry = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-gpt-sovits', 'lib', 'index.js')
  if (requested === 'workspace') return { entry: workspaceEntry, label: 'workspace source' }
  if (requested === 'installed') return { entry: installedEntry, label: 'installed copy' }
  // An installed copy of an older build shadows the new routes and makes every
  // new endpoint look broken, so prefer the tree under test when it is loadable.
  if (existsSync(workspaceEntry) && existsSync(join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'schemastery'))) {
    return { entry: workspaceEntry, label: 'workspace source' }
  }
  return existsSync(installedEntry)
    ? { entry: installedEntry, label: 'installed copy' }
    : { entry: workspaceEntry, label: 'workspace source' }
}

const target = resolveTarget()
const module = await import(pathToFileURL(target.entry).href)
console.log(`host half under test: ${target.label}\n  ${target.entry}\n`)

const stateDir = mkdtempSync(join(tmpdir(), 'gpt-sovits-it-'))

/*
 * Copy the standalone launcher into the throwaway state dir.
 *
 * The host starts the engine by spawning `<stateDir>/start-engine.bat`, so a
 * test dir without one can only ever exercise the "no launcher" path. Copying
 * the real script means this harness can prove the auto-start end to end —
 * including actually bringing a dead engine back.
 */
const realLauncher = join(homedir(), '.dsh', 'gpt-sovits', 'start-engine.bat')
const launcherAvailable = existsSync(realLauncher)
if (launcherAvailable) {
  copyFileSync(realLauncher, join(stateDir, 'start-engine.bat'))
  // The launcher sources `settings.local.bat` for its port and engine root, and
  // only falls back to the profile settings file when that is absent — which is
  // why the real deployment writes this fragment on every save. Write one here
  // too, so the copied launcher targets the same engine instead of guessing.
  const profileSettings = JSON.parse(readFileSync(join(homedir(), '.dsh', 'gpt-sovits', 'settings.json'), 'utf8'))
  writeFileSync(
    join(stateDir, 'settings.local.bat'),
    [
      '@echo off',
      'REM written by the integration harness',
      `if "%PORT%"=="" set "PORT=${new URL(SERVER_URL).port || '9880'}"`,
      `if "%ENGINE_ROOT%"=="" if not "${profileSettings.engineRoot || ''}"=="" set "ENGINE_ROOT=${profileSettings.engineRoot || ''}"`,
      '',
    ].join('\r\n'),
    'ascii',
  )
} else {
  console.log(`note: ${realLauncher} not found — auto-start checks will be skipped\n`)
}
writeFileSync(
  join(stateDir, 'settings.json'),
  JSON.stringify(
    {
      serverUrl: SERVER_URL,
      defaultVoice: '集成测试音色',
      textLang: 'zh',
      speed: 1,
      sampleSteps: 32,
      voices: [
        {
          name: '集成测试音色',
          gptWeights: argOf('--gpt', ''),
          sovitsWeights: argOf('--sovits', ''),
          refAudioPath: REF_AUDIO,
          promptText: '',
          promptLang: 'zh',
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

const routes = []
let routeHandler = null

/** The minimal host context the plugin touches. */
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(route) {
        routes.push({ kind: route.kind, path: route.path })
        if (route.kind === 'exact') routeHandler = route
        routes[routes.length - 1].handler = route.handler
        return () => {}
      },
    }
  },
  logger: { info: (message) => console.log(`[plugin] ${message}`) },
}

const config = new module.Config({ stateDir })
module.apply(ctx, config)

console.log('registered routes:')
for (const route of routes) console.log(`  ${route.kind.padEnd(6)} ${route.path}`)

/** Dispatch one request to the registered route table, exactly as the carrier would. */
function matchRoute(pathname) {
  for (const route of routes) {
    if (route.kind === 'exact' && route.path === pathname) return route
    if (route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`))) return route
  }
  return null
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = matchRoute(url.pathname)
  if (route === null) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no-route' }))
    return
  }
  route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`\nharness listening on ${base}\n`)

/**
 * Stop the engine under test so the launch path can be exercised.
 *
 * The filter must test the path explicitly: `-like` against an empty value
 * silently matches nothing, and an unmatched filter looks exactly like "the
 * engine was already down", which would quietly skip the check.
 */
function stopEngine() {
  try {
    const output = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*GPT-SoVITS*' } | ForEach-Object { Stop-Process -Id $_.Id -Force; $_.Id }",
    ], { encoding: 'utf8', timeout: 30000 })
    return output.trim() !== ''
  } catch {
    return false
  }
}

let failures = 0
const step = async (title, fn) => {
  try {
    const detail = await fn()
    console.log(`  PASS  ${title}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${title} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

console.log('checks:')

await step('GET settings returns the persisted voice', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=settings`)
  assert(response.status === 200, `status ${response.status}`)
  const payload = await response.json()
  assert(payload.ok === true, 'ok flag missing')
  assert(payload.settings.voices.length === 1, 'voice preset not persisted')
  assert(payload.settings.voices[0].name === '集成测试音色', 'voice name lost')
  assert(payload.settings.defaultVoice === '集成测试音色', 'default voice lost')
  assert(Array.isArray(payload.languages) && payload.languages.includes('zh'), 'language list missing')
  return `voices=${payload.settings.voices.length}, languages=${payload.languages.length}`
})

await step('health probe reaches the engine (or reports it down cleanly)', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=health`)
  assert(response.status === 200, `status ${response.status}`)
  const payload = await response.json()
  assert(typeof payload.running === 'boolean', 'running flag missing')
  assert(typeof payload.serverUrl === 'string', 'serverUrl missing')
  return `running=${payload.running} (${payload.detail})`
})

await step('POST settings persists a patch', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ speed: 1.15, sampleSteps: 16, textLang: 'zh' }),
  })
  assert(response.status === 200, `status ${response.status}`)
  const payload = await response.json()
  assert(payload.settings.speed === 1.15, `speed not saved: ${payload.settings.speed}`)
  assert(payload.settings.sampleSteps === 16, `sampleSteps not saved: ${payload.settings.sampleSteps}`)
  assert(payload.settings.voices.length === 1, 'patch dropped the voice presets')
  return `speed=${payload.settings.speed}, sampleSteps=${payload.settings.sampleSteps}`
})

await step('empty text is rejected', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  })
  assert(response.status === 400, `expected 400, got ${response.status}`)
  const payload = await response.json()
  assert(payload.error === 'text-required', `unexpected error: ${payload.error}`)
  return 'HTTP 400 text-required'
})

await step('oversized text is rejected', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(5000) }),
  })
  assert(response.status === 413, `expected 413, got ${response.status}`)
  return 'HTTP 413 text-too-large'
})

await step('unknown action is rejected', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=nope`)
  assert(response.status === 404, `expected 404, got ${response.status}`)
  return 'HTTP 404'
})

await step('missing clip id is rejected', async () => {
  const response = await fetch(`${base}/gpt-sovits/audio/not-a-digest.wav`)
  assert(response.status === 404, `expected 404, got ${response.status}`)
  return 'HTTP 404'
})

await step('cross-origin write is refused', async () => {
  const response = await fetch(`${base}/gpt-sovits/api?action=settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ speed: 1 }),
  })
  assert(response.status === 403, `expected 403, got ${response.status}`)
  const payload = await response.json()
  assert(payload.error === 'cross-origin-forbidden', `unexpected error: ${payload.error}`)
  return 'HTTP 403 cross-origin-forbidden'
})

let clipUrl = null
if (SKIP_SYNTHESIS) {
  console.log('  SKIP  synthesis (--skip-synthesis)')
} else if (!existsSync(REF_AUDIO)) {
  console.log(`  SKIP  synthesis (reference audio not found: ${REF_AUDIO})`)
} else {
  await step('GET models discovers the trained weights in the checkout', async () => {
    const response = await fetch(`${base}/gpt-sovits/api?action=models`)
    assert(response.status === 200, `status ${response.status}`)
    const payload = await response.json()
    assert(payload.ok === true, 'ok flag missing')
    if (payload.engineRoot === '') {
      // Discovery is best-effort: a checkout that is not on this machine is not
      // an integration failure, but it has to be reported rather than hidden.
      return 'no checkout discovered (engineRoot empty) — pass engineRoot in settings to enable'
    }
    assert(Array.isArray(payload.gpt) && Array.isArray(payload.sovits), 'model lists missing')
    assert(payload.gpt.length > 0, 'no .ckpt found under GPT_weights*')
    assert(payload.sovits.length > 0, 'no .pth found under SoVITS_weights*')
    assert(payload.gpt.every((item) => item.path.endsWith('.ckpt')), 'gpt list must hold .ckpt files')
    assert(payload.sovits.every((item) => item.path.endsWith('.pth')), 'sovits list must hold .pth files')
    return `${payload.gpt.length} gpt + ${payload.sovits.length} sovits under ${payload.engineRoot}`
  })

  let clipUrl = null
  if (GPT_WEIGHTS !== '' || SOVITS_WEIGHTS !== '') {
    await step('weight switching happens once, then is skipped while unchanged', async () => {
      // Count the engine-directed GETs by wrapping the global fetch the plugin
      // uses. Switching weights reloads them from disk, so issuing the call on
      // every utterance would make each reply pay the reload cost.
      const realFetch = globalThis.fetch
      const engineCalls = []
      globalThis.fetch = (input, init) => {
        const target = String(input)
        if (target.includes(':9880/')) engineCalls.push(target)
        return realFetch(input, init)
      }
      try {
        const first = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '切换权重的第一次验证。' }),
        })
        const firstPayload = await first.json()
        assert(firstPayload.ok === true, `first synthesis failed: ${firstPayload.message ?? firstPayload.error}`)
        const afterFirst = engineCalls.filter((url) => url.includes('/set_')).length

        const second = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '切换权重的第二次验证。' }),
        })
        const secondPayload = await second.json()
        assert(secondPayload.ok === true, `second synthesis failed: ${secondPayload.message ?? secondPayload.error}`)
        const afterSecond = engineCalls.filter((url) => url.includes('/set_')).length

        assert(afterFirst >= 1, 'no weight switch was issued for a preset that names weights')
        assert(
          afterSecond === afterFirst,
          `weights were switched again for an unchanged preset (${afterFirst} -> ${afterSecond})`,
        )
        const setters = engineCalls.filter((url) => url.includes('/set_')).map((url) => url.replace(/\?.*$/, '').split(':9880')[1])
        return `${afterFirst} switch call(s) on first, 0 on second — ${[...new Set(setters)].join(', ')}`
      } finally {
        globalThis.fetch = realFetch
      }
    })
  } else {
    console.log('  SKIP  weight switching (pass --gpt and --sovits to exercise it)')
  }

  /*
   * Ordered *after* the weight-switch check on purpose.
   *
   * The host remembers which weight pair the engine currently holds
   * (`activeGpt`/`activeSovits`), so a synthesis here would switch the weights and
   * the weight-switch test that follows would then see "unchanged" and issue no
   * setter call. Running the greeting last keeps that test's precondition — a first
   * synthesis with named weights — intact.
   */
  await step('the status route reports what the plugin is doing', async () => {
    /*
     * Built because "the greeting did not arrive" had no answer from outside: models
     * loading, a preview holding the single worker, and a clip that was synthesized
     * but never played all look identical. This route is what tells them apart, so it
     * must always answer and must carry the fields the settings page renders.
     */
    const response = await fetch(`${base}/gpt-sovits/api?action=status`)
    assert(response.status === 200, `expected 200, got ${response.status}`)
    const payload = await response.json()
    assert(payload.ok === true, 'the status route must report ok')
    for (const field of ['serverUrl', 'voiceName', 'textLang', 'speed', 'sampleSteps', 'activeGpt', 'activeSovits', 'audioCache']) {
      assert(field in payload, `status is missing ${field}`)
    }
    assert(payload.greeting !== null && typeof payload.greeting === 'object', 'status must carry the greeting state')
    assert(
      ['idle', 'synthesizing', 'ready'].includes(payload.greeting.state),
      `unexpected greeting state: ${payload.greeting.state}`,
    )
    assert(Array.isArray(payload.history), 'status must carry a synthesis history')
    assert(typeof payload.busy === 'boolean', 'status must report whether the engine is busy')
    return `engine busy=${payload.busy}, greeting=${payload.greeting.state}, history=${payload.history.length}`
  })

  await step('the logs route serves the engine console', async () => {
    /*
     * This replaces the API console window: the engine's stdout/stderr, the supervisor's
     * decisions and the transcript. A separate window stole focus and, worse, closing it
     * killed the engine, because that window *is* the process's console.
     */
    const response = await fetch(`${base}/gpt-sovits/api?action=logs&lines=120`)
    assert(response.status === 200, `expected 200, got ${response.status}`)
    const payload = await response.json()
    assert(payload.ok === true, 'the logs route must report ok')
    for (const section of ['engine', 'supervisor']) {
      assert(payload[section] !== null && typeof payload[section] === 'object', `logs.${section} must be an object`)
      assert(Array.isArray(payload[section].lines), `logs.${section}.lines must be an array`)
      assert(typeof payload[section].path === 'string', `logs.${section}.path must name the file`)
    }
    assert(Array.isArray(payload.transcript), 'the console must also carry the transcript')
    // The line limit is clamped, so a caller cannot ask for an unbounded read.
    const clamped = await fetch(`${base}/gpt-sovits/api?action=logs&lines=99999`).then((r) => r.json())
    assert(clamped.ok === true && clamped.engine.lines.length <= 2000, 'the line limit must be clamped')
    return `engine ${payload.engine.lines.length} lines, supervisor ${payload.supervisor.lines.length} lines`
  })

  await step('the greeting is produced once the engine is idle, and polled into existence', async () => {
    /*
     * The user's design, verified as the client drives it: ask every 500 ms; the host
     * answers immediately with a state, and only synthesizes once the engine is free.
     *
     * This is the behaviour every earlier timing guess failed to produce on a real
     * machine. The assertions are therefore about the contract rather than the timing:
     * every reply arrives immediately, carries a state, and the sequence terminates in a
     * playable clip.
     */
    const started = Date.now()
    let clip = null
    let last = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const t0 = Date.now()
      const response = await fetch(`${base}/gpt-sovits/api?action=greeting`)
      const elapsed = Date.now() - t0
      assert(response.status === 200, `expected 200, got ${response.status}`)
      last = await response.json()
      // Immediate: a poll that blocked on a cold engine would pile up behind it.
      assert(elapsed < 3000, `the greeting route must answer immediately, took ${elapsed} ms`)
      assert(typeof last.state === 'string', `every reply must carry a state, got ${JSON.stringify(last)}`)
      if (last.ok === true && typeof last.url === 'string') {
        clip = last
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert(clip !== null, `the greeting never became ready; last reply was ${JSON.stringify(last)}`)
    const audio = await fetch(`${base}${clip.url}`)
    assert(audio.status === 200, `the greeting clip must be servable, got ${audio.status}`)
    const bytes = Buffer.from(await audio.arrayBuffer())
    assert(bytes.subarray(0, 4).toString('ascii') === 'RIFF', 'the greeting must be a real WAV')
    return `${bytes.length} B in ${Date.now() - started} ms, final state ${clip.state}`
  })

  await step('a synthesis is recorded in the status history', async () => {
    // The history is the field that answers "is it generating, and what?" — the
    // question that previously needed a log file.
    const before = await fetch(`${base}/gpt-sovits/api?action=status`).then((r) => r.json())
    const synthesized = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这一句应当出现在运行状况里。' }),
    }).then((r) => r.json())
    assert(synthesized.ok === true, `synthesis failed: ${synthesized.message ?? synthesized.error}`)

    const after = await fetch(`${base}/gpt-sovits/api?action=status`).then((r) => r.json())
    assert(after.history.length >= Math.min(before.history.length + 1, 1), 'the synthesis must appear in the history')
    const newest = after.history[0]
    assert(
      typeof newest.text === 'string' && newest.text.includes('这一句应当出现在运行状况里'),
      `unexpected newest entry: ${JSON.stringify(newest)}`,
    )
    assert(typeof newest.ms === 'number', 'the history entry must record how long synthesis took')
    return `history ${before.history.length} -> ${after.history.length}, newest ${newest.ms} ms`
  })

  await step('the greeting route exists and is switchable', async () => {
    const saved = await fetch(`${base}/gpt-sovits/api?action=settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ greetOnStart: false }),
    }).then((r) => r.json())
    assert(saved.ok === true, 'disabling the greeting must save')
    assert(saved.settings.greetOnStart === false, `greetOnStart should be false, got ${saved.settings.greetOnStart}`)

    // Disabled must answer without touching the engine: a user who turned it off
    // should not pay for a synthesis just to be told it is off.
    const off = await fetch(`${base}/gpt-sovits/api?action=greeting`).then((r) => r.json())
    assert(off.ok === true && off.enabled === false, `a disabled greeting must answer enabled:false, got ${JSON.stringify(off)}`)

    const on = await fetch(`${base}/gpt-sovits/api?action=settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ greetOnStart: true, greetText: '你好，欢迎回来' }),
    }).then((r) => r.json())
    assert(on.settings.greetOnStart === true, 'the greeting must be switchable back on')
    assert(on.settings.greetText === '你好，欢迎回来', `greeting text did not persist: ${on.settings.greetText}`)

    const greeting = await fetch(`${base}/gpt-sovits/api?action=greeting`).then((r) => r.json())
    assert(greeting.enabled === true, 'an enabled greeting must report enabled:true')
    assert(greeting.text === '你好，欢迎回来', `unexpected greeting text: ${greeting.text}`)
    if (greeting.ok === true) {
      assert(
        typeof greeting.url === 'string' && greeting.url.startsWith('/gpt-sovits/audio/'),
        'a synthesized greeting must carry a clip URL',
      )
      const clip = await fetch(`${base}${greeting.url}`)
      assert(clip.status === 200, `the greeting clip must be servable, got ${clip.status}`)
      return `enabled -> ${greeting.bytes} byte clip`
    }
    // A greeting that cannot be synthesized is a missing nicety, not a failure:
    // it must answer 200 with ok:false so the caller stays unaware.
    assert(greeting.error === 'greeting-failed', `an unsynthesizable greeting must report greeting-failed, got ${greeting.error}`)
    return 'enabled -> reported failure, no throw'
  })

  await step('ensure-engine starts the engine when it is down, and is a no-op when up', async () => {
    // Up: must not start a second engine.
    const running = await fetch(`${base}/gpt-sovits/api?action=ensure-engine`, { method: 'POST' })
    assert(running.status === 200, `status ${running.status}`)
    const runningPayload = await running.json()
    assert(runningPayload.ok === true, 'ok flag missing')
    assert(runningPayload.running === true, 'a live engine must be reported as running')
    assert(runningPayload.launched === false, 'a live engine must not be launched again')

    if (!launcherAvailable) return 'engine running; launch path skipped (no launcher)'

    // Down: stop the engine, ask the host, and expect it back.
    const stopped = stopEngine()
    if (!stopped) return 'engine running; could not stop it to test the launch path'
    const started = await fetch(`${base}/gpt-sovits/api?action=ensure-engine`, { method: 'POST' })
    const startedPayload = await started.json()
    assert(startedPayload.launched === true, `the host did not launch the engine: ${JSON.stringify(startedPayload)}`)

    // The launcher waits for readiness itself; poll the host's own probe.
    let healthy = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const health = await fetch(`${base}/gpt-sovits/api?action=health`).then((r) => r.json())
      if (health.running === true) {
        healthy = true
        break
      }
    }
    assert(healthy, 'the engine did not come back within 120s of being launched')
    return 'no-op when up, relaunched when down'
  })

  await step('synthesis produces a playable WAV served over the audio route', async () => {
    const started = Date.now()
    const response = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: TEXT }),
    })
    const payload = await response.json()
    assert(response.status === 200 && payload.ok === true, `synthesis failed: ${payload.message ?? payload.error ?? response.status}`)
    assert(typeof payload.url === 'string' && payload.url.startsWith('/gpt-sovits/audio/'), `bad url: ${payload.url}`)
    assert(payload.bytes > 1000, `suspiciously small clip: ${payload.bytes} bytes`)
    clipUrl = payload.url

    const audio = await fetch(`${base}${payload.url}`)
    assert(audio.status === 200, `audio route status ${audio.status}`)
    assert(audio.headers.get('content-type') === 'audio/wav', `content-type ${audio.headers.get('content-type')}`)
    const bytes = Buffer.from(await audio.arrayBuffer())
    assert(bytes.subarray(0, 4).toString('ascii') === 'RIFF', 'body is not a WAV')
    assert(bytes.length === payload.bytes, `length mismatch: ${bytes.length} vs ${payload.bytes}`)
    return `${(bytes.length / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)}s, cached=${payload.cached}`
  })

  if (clipUrl !== null) {
    await step('the synthesized clip is byte-identical on replay (cache hit)', async () => {
      const first = Buffer.from(await (await fetch(`${base}${clipUrl}`)).arrayBuffer())
      const again = await fetch(`${base}/gpt-sovits/api?action=synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: TEXT }),
      })
      const payload = await again.json()
      assert(payload.cached === true, 'second synthesis was not a cache hit')
      assert(payload.url === clipUrl, `cache returned a different url: ${payload.url}`)
      const second = Buffer.from(await (await fetch(`${base}${payload.url}`)).arrayBuffer())
      assert(first.equals(second), 'cached bytes differ from the first response')
      return `${first.length} bytes identical`
    })
  }
}

server.close()
console.log(`\nstate dir: ${stateDir}`)
if (failures > 0) {
  console.log(`\nFAILED: ${failures} check(s)`)
  process.exitCode = 1
} else {
  console.log('\nAll integration checks passed.')
}
