import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const dir = 'C:/Users/koukou/Documents/deepseek-harness/default-workspace/dsh-gpt-sovits'
const code = readFileSync(dir + '/lib/client.js', 'utf8')

let captured = null
const reactStub = {
  createElement: () => null, useEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, memo: (f) => f, useState: (v) => [v, () => {}], useContext: () => null,
}
const seeds = new Map([['react', reactStub], ['react/jsx-runtime', { jsx: () => null, jsxs: () => null, Fragment: 'F' }]])
const store = new Map()
const sb = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  queueMicrotask, Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp,
  Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, Symbol, Reflect, Intl,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  TextDecoder, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal,
  requestAnimationFrame: (fn) => { fn(); return 1 }, cancelAnimationFrame: () => {}, innerHeight: 900,
}
sb.window = sb
sb.globalThis = sb
sb.self = sb
sb.document = { querySelector: () => null, querySelectorAll: () => [], body: null, createElement: () => ({ style: {} }), createTreeWalker: () => ({ nextNode: () => null }), createRange: () => ({}), addEventListener() {}, removeEventListener() {} }
sb.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
sb.window.__ModuleLoader__ = { load: (e) => { captured = e } }
sb.window.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
sb.window.Audio = class { play() { return Promise.resolve() } pause() {} }
sb.window.location = { href: 'dsh-app://app/' }
sb.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
vm.createContext(sb)
vm.runInContext(code, sb, { filename: 'client.js' })
const exports = captured.factory((s) => seeds.get(s))
exports.apply({ logger: {}, get: () => undefined, inject: (_d, cb) => cb(), effect: (fn) => { try { fn() } catch {} }, on: () => () => {}, locale: { getLocale: () => ({ active: 'zh' }), bind: () => (k) => k, register: () => () => {} }, slots: { inject: (_n, cb) => cb(), register: () => () => {} } })

const api = exports.__test

/** Build a fake scope whose blocks share one left edge, with a couple of indented ones. */
const scopeWith = (edges, width = 1200) => ({
  clientWidth: width,
  querySelectorAll: () => edges.map((left) => ({ getBoundingClientRect: () => ({ left, width: 600, height: 20, top: 0, bottom: 20 }) })),
})

const cases = [
  { name: '正常居中列（含缩进）', edges: [226, 226, 226, 252, 226, 252], expect: 226 },
  { name: '全部缩进（列表页）', edges: [252, 252], expect: 252 },
  { name: '单块回退', edges: [226], expect: 226 },
  { name: '空作用域', edges: [], expect: null },
]

let bad = 0
for (const c of cases) {
  const got = api.answerColumnForTest(scopeWith(c.edges))
  const ok = got === c.expect
  if (!ok) bad += 1
  console.log(`  ${ok ? '✅' : '❌'} ${c.name}  →  ${got}  ${ok ? '' : '(期望 ' + c.expect + ')'}`)
}

// Cache invalidation: same scope object but a different clientWidth must recompute.
const scope = scopeWith([226, 226, 226])
const first = api.answerColumnForTest(scope)
scope.querySelectorAll = () => [300, 300, 300].map((left) => ({ getBoundingClientRect: () => ({ left, width: 500, height: 20, top: 0, bottom: 20 }) }))
const cached = api.answerColumnLeft(scope)
scope.clientWidth = 900
const recomputed = api.answerColumnLeft(scope)
console.log('')
console.log(`  首次: ${first}`)
console.log(`  同宽复用缓存: ${cached} ${cached === first ? '✅' : '❌'}`)
console.log(`  宽度变化后重算: ${recomputed} ${recomputed === 300 ? '✅' : '❌'}`)
if (cached !== first || recomputed !== 300) bad += 1

console.log('')
console.log(bad === 0 ? '  ✅ 全部通过' : `  ⚠️ ${bad} 个失败`)
process.exit(bad === 0 ? 0 : 1)
