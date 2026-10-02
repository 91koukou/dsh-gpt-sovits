window.__ModuleLoader__.load({
	id: "dsh-gpt-sovits",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/*
		 * No other bare `require` is allowed in this bundle.
		 *
		 * Measured the hard way: `@deepseek-ai/dsh-client-ui-primitives` has no
		 * `lib/client.js` and therefore **no row in the boot graph**, so requiring it
		 * throws "not a row in the boot graph" — and because that happens while the
		 * module is being loaded, the plugin never activates and the whole web boot
		 * fails with "1 entry did not activate" and an app-stopped dialog. A
		 * `try`/`catch` does not help: the loader reports the failure outside the
		 * call, so the catch never sees it.
		 *
		 * Only `react` and `react/jsx-runtime` are platform seed words. Everything
		 * else this plugin draws, it draws itself.
		 */

		const h = react.createElement;
		const NS = "gpt-sovits";
		const API = "/gpt-sovits/api";
		const CLIP_ROUTE = "/gpt-sovits/audio/";
		const AUTOPLAY_KEY = "gpt-sovits.autoRead";
		const VOLUME_KEY = "gpt-sovits.volume";
		const SPEED_KEY = "gpt-sovits.speed";
		const LAST_READ_KEY = "gpt-sovits.lastRead";
		const DEFAULT_VOLUME = 0.9;
		/** Clips are split on sentence boundaries so long replies start speaking sooner. */
		const CHUNK_CHARS = 110;
		const MAX_INPUT_CHARS = 4000;

		// ────────────────────────────────────────────────────────────────
		// Browser-local playback preferences.
		// ────────────────────────────────────────────────────────────────

		function readStored(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : raw;
			} catch {
				return fallback;
			}
		}

		function writeStored(key, value) {
			try {
				if (value === null) window.localStorage.removeItem(key);
				else window.localStorage.setItem(key, value);
			} catch {
				/* storage disabled — preferences stay in memory for this page */
			}
		}

		const autoReadEnabled = () => readStored(AUTOPLAY_KEY, "") === "1";
		const autoReadListeners = new Set();
		const setAutoRead = (enabled) => {
			writeStored(AUTOPLAY_KEY, enabled ? "1" : null);
			for (const listener of autoReadListeners) {
				try { listener(); } catch { /* one bad listener must not block the rest */ }
			}
		};
		const subscribeAutoRead = (fn) => {
			autoReadListeners.add(fn);
			return () => autoReadListeners.delete(fn);
		};

		function getVolume() {
			const raw = readStored(VOLUME_KEY, null);
			if (raw === null) return DEFAULT_VOLUME;
			const value = Number(raw);
			return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
		}
		function setVolume(value) {
			writeStored(VOLUME_KEY, String(Math.min(1, Math.max(0, value))));
		}

		/** Rate control needs `preservesPitch`, otherwise 1x beats a chipmunked voice. */
		function speedSupported() {
			try {
				return typeof HTMLAudioElement !== "undefined"
					&& "playbackRate" in HTMLAudioElement.prototype
					&& "preservesPitch" in HTMLAudioElement.prototype;
			} catch {
				return false;
			}
		}
		function getSpeed() {
			const raw = readStored(SPEED_KEY, null);
			if (raw === null) return 1;
			const value = Number(raw);
			return Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : 1;
		}
		function setSpeed(value) {
			writeStored(SPEED_KEY, String(Math.min(2, Math.max(0.5, value))));
		}

		// ────────────────────────────────────────────────────────────────
		// Text hygiene: strip everything that should not be spoken.
		// ────────────────────────────────────────────────────────────────

		const WORDS = {
			zh: { link: "链接", path: "路径", id: "编号", code: "代码", codeBlock: "（代码块已省略）" },
			en: { link: "link", path: "path", id: "id", code: "code", codeBlock: " (code block omitted) " },
		};

		/**
		 * Turn assistant markdown into speakable prose.
		 *
		 * Code fences are dropped whole rather than read, and URLs/hashes/long
		 * identifiers collapse to a word: reading them aloud is noise, and the
		 * engine can stall on symbol soup.
		 *
		 * CREDIT: this regular-expression chain is adapted from `dsh-fish-tts`
		 * (https://github.com/MaRi23333/dsh-fish-tts, MIT, © 2026 dsh-fish-tts
		 * contributors), function `cleanForTts`. Most patterns are byte-identical;
		 * the local changes are the `{28,}` long-identifier threshold (upstream
		 * `{24,}`), an `|$` alternative so an unterminated fence still matches, a
		 * multiline emphasis pattern, and the added heading / blockquote / list /
		 * rule stripping. See THIRD-PARTY-NOTICES.md for the full list.
		 */
		function cleanForSpeech(text, words) {
			return String(text ?? "")
				.replace(/```[\s\S]*?(?:```|$)/g, ` ${words.codeBlock} `)
				.replace(/`([^`\n]+)`/g, "$1")
				.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/https?:\/\/[^\s<>"|)\]]+/g, words.link)
				.replace(/[A-Za-z]:\\[^\s<>"|]+/g, words.path)
				.replace(/(^|[\s(（])(?:~\/|\.{1,2}\/)[^\s<>"|]+/g, `$1${words.path}`)
				.replace(/\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/g, words.id)
				.replace(/\b[0-9a-fA-F]{16,}\b/g, words.id)
				.replace(/[A-Za-z0-9+/=_-]{28,}/g, words.code)
				.replace(/^\s{0,3}#{1,6}\s+/gm, "")
				.replace(/^\s{0,3}>\s?/gm, "")
				.replace(/^\s*[-*+]\s+/gm, "")
				.replace(/^\s*\d+[.)]\s+/gm, "")
				.replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, "")
				.replace(/<[^>]+>/g, " ")
				.replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?)(?<=\S)\1/g, "$2")
				.replace(/[ \t]+/g, " ")
				.replace(/\n{2,}/g, "\n")
				.trim();
		}

		/**
		 * Turn cleaned prose into speakable chunks.
		 *
		 * Sentence boundaries first, then hard splits for a single run-on
		 * sentence, so no request is ever unbounded. Leading punctuation is
		 * stripped from every chunk: `gpt-sovits` splits on trailing punctuation,
		 * so a chunk starting with `。` becomes an empty first sentence, and the
		 * engine then logs `。你好…` and synthesizes a stray pause.
		 */
		function splitIntoChunks(text) {
			const chunks = [];
			let current = "";
			/** Drop leading punctuation and whitespace; keep the sentence itself. */
			const tidy = (value) => value.replace(/^[\s。！？!?；;…，,、：:）)】」』"']+/, "").trim();
			const take = (value) => {
				const cleaned = tidy(value);
				if (cleaned !== "") chunks.push(cleaned);
			};
			const sentences = String(text ?? "").split(/(?<=[。！？!?；;…])\s*|\n+/);
			for (const sentence of sentences) {
				if (sentence.length > CHUNK_CHARS * 2) {
					take(current);
					current = "";
					for (let i = 0; i < sentence.length; i += CHUNK_CHARS) {
						take(sentence.slice(i, i + CHUNK_CHARS));
					}
					continue;
				}
				if (current.length + sentence.length > CHUNK_CHARS) {
					take(current);
					current = "";
				}
				current += sentence;
			}
			take(current);
			return chunks;
		}

		// ────────────────────────────────────────────────────────────────
		// Player: one channel, newest request wins, synthesis prefetched.
		// ────────────────────────────────────────────────────────────────

		class SovitsPlayer {
			constructor() {
				this.audio = null;
				this.currentKey = null;
				this.currentText = null;
				this.playing = false;
				this.busy = false;
				this.error = null;
				/** Bumped by every stop()/play() so a superseded response never starts audio. */
				this.generation = 0;
				this.listeners = new Set();
			}

			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			}

			notify() {
				for (const listener of this.listeners) {
					try { listener(); } catch { /* a broken subscriber must not stop playback */ }
				}
			}

			playingFor(text) {
				return this.playing && this.currentText === text;
			}

			describe() {
				return { playing: this.playing, busy: this.busy, error: this.error, text: this.currentText };
			}

			/** Release the current clip and invalidate any in-flight synthesis. */
			stop() {
				this.generation += 1;
				if (this.audio !== null) {
					try {
						this.audio.pause();
						this.audio.src = "";
					} catch { /* already detached */ }
					this.audio = null;
				}
				this.playing = false;
				this.busy = false;
				this.currentText = null;
				this.currentKey = null;
				this.notify();
			}

			/** Ask the host to synthesize one chunk and return its playable URL. */
			/** Ask the host to bring the engine up; resolves once it has been asked. */
			async ensureEngine() {
				try {
					const response = await fetch(`${API}?action=ensure-engine`, { method: "POST" });
					const payload = await response.json().catch(() => null);
					diag("ensure-engine", payload === null ? { status: response.status } : payload);
					return payload !== null && payload.launched === true;
				} catch (error) {
					diag("ensure-engine-failed", { message: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}

			async requestClip(chunk, generation) {
				const send = async () => {
					const response = await fetch(`${API}?action=synthesize`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: chunk }),
					});
					let payload = null;
					try { payload = await response.json(); } catch { /* fall through to status text */ }
					return { response, payload };
				};

				let { response, payload } = await send();
				if (generation !== this.generation) return null;

				/*
				 * A dead engine is the one failure the user cannot fix from the
				 * player, and it is also the most common one (the engine dies with
				 * DSH). Ask the host to start it, then retry once: the launcher
				 * waits for readiness, so a single retry is enough to turn the
				 * failure into audio instead of an error message.
				 */
				if (!response.ok || payload === null || payload.ok !== true) {
					const detail = String((payload && (payload.message || payload.error)) || "");
					// Only a transport-level failure means "the engine is down".
					// A missing reference clip must not trigger a restart loop.
					if (/fetch failed|ECONNREFUSED|socket hang up|ENOTFOUND/i.test(detail)) {
						diag("engine-down", { detail, status: response.status });
						const launched = await this.ensureEngine();
						if (launched && generation === this.generation) {
							({ response, payload } = await send());
							if (generation !== this.generation) return null;
						}
					}
				}

				if (!response.ok || payload === null || payload.ok !== true) {
					const detail = payload && (payload.message || payload.error);
					throw new Error(detail || `HTTP ${response.status}`);
				}
				return payload.url;
			}

			/** Play one URL to completion. Resolves early when superseded. */
			playClip(url, generation) {
				return new Promise((resolve, reject) => {
					const audio = new Audio(url);
					audio.volume = getVolume();
					if (speedSupported()) {
						audio.preservesPitch = true;
						audio.defaultPlaybackRate = getSpeed();
						audio.playbackRate = getSpeed();
					}
					this.audio = audio;
					const done = () => {
						audio.onended = null;
						audio.onerror = null;
						resolve();
					};
					audio.onended = done;
					audio.onerror = () => {
						audio.onerror = null;
						reject(new Error("audio playback failed"));
					};
					audio.play().then(
						() => {
							if (generation !== this.generation) {
								done();
								return;
							}
							this.playing = true;
							this.busy = false;
							this.notify();
						},
						(error) => {
							// Autoplay policy: the click that started this counts as a
							// gesture, but a blocked play() must surface, not hang.
							reject(error instanceof Error ? error : new Error("playback blocked"));
						},
					);
				});
			}

			/**
			 * Speak one assistant reply.
			 *
			 * Synthesis of chunk N+1 overlaps playback of chunk N, so a long
			 * reply starts talking after the first sentence instead of after all
			 * of it.
			 */
			async play(text, words) {
				const source = String(text ?? "");
				const cleaned = cleanForSpeech(source, words);
				if (cleaned === "") return;

				this.stop();
				const generation = this.generation;
				this.currentText = source;
				this.currentKey = source;
				this.busy = true;
				this.error = null;
				this.notify();

				const chunks = splitIntoChunks(cleaned);
				if (chunks.length === 0) {
					this.busy = false;
					this.notify();
					return;
				}

				try {
					let pending = this.requestClip(chunks[0], generation);
					for (let index = 0; index < chunks.length; index += 1) {
						const url = await pending;
						if (generation !== this.generation || url === null) return;
						if (index + 1 < chunks.length) {
							// Kick off the next chunk before this one finishes playing.
							pending = this.requestClip(chunks[index + 1], generation);
							pending.catch(() => { /* reported when awaited */ });
						}
						await this.playClip(url, generation);
						if (generation !== this.generation) return;
					}
				} catch (error) {
					if (generation === this.generation) {
						this.error = error instanceof Error ? error.message : String(error);
					}
					throw error;
				} finally {
					if (generation === this.generation) {
						this.busy = false;
						this.playing = false;
						this.currentText = null;
						this.notify();
					}
				}
			}

			/** Read the persisted settings, engine health, and the discovered models. */
			async loadState() {
				const [settingsResponse, healthResponse, modelsResponse] = await Promise.all([
					fetch(`${API}?action=settings`),
					fetch(`${API}?action=health`),
					fetch(`${API}?action=models`),
				]);
				const settingsPayload = await settingsResponse.json().catch(() => null);
				const healthPayload = await healthResponse.json().catch(() => null);
				const modelsPayload = await modelsResponse.json().catch(() => null);
				return {
					settings: settingsPayload && settingsPayload.ok ? settingsPayload.settings : null,
					languages: settingsPayload && settingsPayload.ok ? settingsPayload.languages : [],
					health: healthPayload && healthPayload.ok ? healthPayload : null,
					models: modelsPayload && modelsPayload.ok ? modelsPayload : null,
				};
			}

			/** Persist a settings patch and return the effective settings. */
			async saveSettings(patch) {
				const response = await fetch(`${API}?action=settings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload === null || payload.ok !== true) {
					throw new Error((payload && (payload.message || payload.error)) || `HTTP ${response.status}`);
				}
				return payload.settings;
			}

			/** Speak a fixed sample so the user can audition the configured voice. */
			preview(sample, words) {
				return this.play(sample, words);
			}
		}

		const player = new SovitsPlayer();

		// ────────────────────────────────────────────────────────────────
		// Reading assistant text out of the chat store.
		// ────────────────────────────────────────────────────────────────

		/** Join the text blocks of one assistant content list. */
		function blocksToText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks
				.filter((block) => block && block.kind === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
		}

		/**
		 * Every chat node, in timeline order.
		 *
		 * Measured against the running shell: `snapshot.nodes` is a purpose-built
		 * container whose own members are `byKey`, `turnKinds`, `valuesCache`, …
		 * The only accessor that yields the nodes is **`values()`** — there is no
		 * `size`, no `Map` brand, and `all`/`list`/`toArray` do not exist. The
		 * earlier duck-type test demanded both `values` and `size`, so it matched
		 * nothing and every read came back empty.
		 *
		 * `snapshot.order` carries the node keys in timeline order; `values()` order
		 * is an implementation detail, so the order array is preferred when present.
		 * The legacy array layout is kept as a fallback for a different shell.
		 */
		function snapshotNodes(snapshot) {
			if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") return [];
			const container = snapshot.nodes;
			if (container !== null && container !== undefined && typeof container === "object") {
				let nodes = [];
				if (typeof container.values === "function") {
					try {
						const listed = container.values();
						nodes = Array.isArray(listed) ? listed : Array.from(listed ?? []);
					} catch {
						nodes = [];
					}
				}
				if (!Array.isArray(nodes)) nodes = [];
				if (nodes.length === 0 && typeof container.get === "function" && Array.isArray(snapshot.order)) {
					// Fall back to the documented accessor, driven by the order array.
					for (const key of snapshot.order) {
						try {
							const node = container.get(key);
							if (node !== null && node !== undefined) nodes.push(node);
						} catch {
							/* a stale key is not fatal */
						}
					}
				}
				if (nodes.length > 0) {
					// `values()` is in insertion order; reorder by `order` when it lines up.
					if (Array.isArray(snapshot.order) && snapshot.order.length === nodes.length && typeof container.get === "function") {
						const byKey = new Map();
						for (const key of snapshot.order) {
							try {
								const node = container.get(key);
								if (node !== null && node !== undefined) byKey.set(node, true);
							} catch {
								/* ignore */
							}
						}
						if (byKey.size === nodes.length) {
							const ordered = nodes.filter((node) => byKey.has(node));
							if (ordered.length === nodes.length) nodes = ordered;
						}
					}
					return nodes;
				}
			}
			if (Array.isArray(container)) return container;
			const legacy = snapshot.legacy;
			if (legacy !== null && typeof legacy === "object" && Array.isArray(legacy.nodes)) return legacy.nodes;
			return [];
		}

		/** Whether a node is a settled assistant step. */
		function isAssistantNode(node) {
			return node !== null && typeof node === "object" && node.kind === "assistant-step" && node.data !== null && typeof node.data === "object";
		}

		/** The message id a node carries, from either layout. */
		function nodeMessageId(node) {
			const settled = node.data.finalNode;
			const id = settled !== null && typeof settled === "object" ? settled.messageId : node.data.messageId;
			return id === undefined || id === null ? null : String(id);
		}

		/** The content blocks a node carries, settled form first. */
		function nodeBlocks(node) {
			const settled = node.data.finalNode;
			if (settled !== null && typeof settled === "object" && Array.isArray(settled.blocks)) return settled.blocks;
			return Array.isArray(node.data.blocks) ? node.data.blocks : [];
		}

		/**
		 * Text of one assistant message.
		 *
		 * Prefers an exact id match, then falls back to a node-level `messageId`.
		 */
		function selectText(snapshot, messageId) {
			const wanted = messageId === undefined || messageId === null ? null : String(messageId);
			if (wanted === null) return "";
			for (const node of snapshotNodes(snapshot)) {
				if (!isAssistantNode(node)) continue;
				if (nodeMessageId(node) !== wanted) continue;
				return blocksToText(nodeBlocks(node));
			}
			return "";
		}

		/**
		 * Identity of the newest assistant reply that carries text.
		 *
		 * A message id is the unit of auto-read de-duplication: the same reply must
		 * not be spoken twice across re-renders, session switches, or a page reload.
		 */
		function selectLatestMessageId(snapshot) {
			const nodes = snapshotNodes(snapshot);
			for (let index = nodes.length - 1; index >= 0; index -= 1) {
				const node = nodes[index];
				if (!isAssistantNode(node)) continue;
				if (blocksToText(nodeBlocks(node)).trim() === "") continue;
				const id = nodeMessageId(node);
				if (id !== null) return id;
			}
			return null;
		}

		// ────────────────────────────────────────────────────────────────
		// UI atoms.
		// ────────────────────────────────────────────────────────────────

		const LABEL_COLOR = "var(--dsw-alias-label-tertiary, #7a7a7a)";
		const PRIMARY_COLOR = "var(--dsw-alias-label-primary, #1a1a1a)";
		const DANGER_COLOR = "var(--dsw-alias-state-error-primary, #e5484d)";
		const BORDER_COLOR = "var(--dsw-alias-border-l2, #d9d9d9)";
		const CARD_FILL = "var(--dsw-alias-settings-card-fill, transparent)";
		const CARD_STROKE = "var(--dsw-alias-settings-card-stroke, #ebebeb)";
		const ACTIVE_COLOR = "var(--dsw-alias-brand-primary-new-color, #4d6bfe)";

		/**
		 * Buttons carry a stylesheet rather than inline styles.
		 *
		 * Inline styles cannot express `:hover` or `[data-active]`, and the shell's
		 * own action buttons get their affordance from exactly those. The class
		 * names are scoped and the tag is registered through the loader's CSS
		 * claim protocol, so unloading the plugin removes it.
		 */
		const CSS = {
			action: "gptsovits_action",
			toggle: "gptsovits_toggle",
		};

		/** Install the plugin stylesheet once, keyed like the shell's own plugin CSS. */
		function installStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-gpt-sovits/client.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-gpt-sovits";
			tag.dataset.pluginCss = tagId;
			// Geometry mirrors the shell's message-action buttons (28px box, 6px
			// padding, 15px glyph) so the speaker sits in the same optical rhythm as
			// copy/branch/feedback, and the composer toggle mirrors its 28px rail.
			tag.textContent = `
.${CSS.action}{box-sizing:border-box;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.${CSS.action} svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.${CSS.action}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.${CSS.action}[data-active]{color:${ACTIVE_COLOR}}
.${CSS.action}[data-failed]{color:${DANGER_COLOR}}
.${CSS.action}:disabled{cursor:default;opacity:.4}
.${CSS.toggle}{flex:none;box-sizing:border-box;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.${CSS.toggle} svg{width:16px;height:16px}
.${CSS.toggle}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.${CSS.toggle}[data-active]{color:${ACTIVE_COLOR}}
/*
 * Fallback only: keep the read-aloud button visible while the shell fades its
 * row out. The shell hides the whole row with
 *   [data-actions-reveal=hover] ... .<shell actions> { opacity: 0 }
 * The effect in ReadAloudAction is the primary mechanism; this covers the moment
 * before it runs. Kept deliberately simple — an exotic selector here would be a
 * poor trade for two buttons that already have a working JavaScript path.
 */
[data-actions-reveal="hover"] .${CSS.action}{opacity:1}
`;
			// A malformed stylesheet must not take the rest of the plugin down: the
			// row-reveal effect is the primary mechanism and needs no CSS at all.
			try {
				document.head.appendChild(tag);
			} catch (error) {
				diag("style-failed", { message: error instanceof Error ? error.message : String(error) });
			}
		}
		try {
			installStyles();
		} catch (error) {
			diag("style-install-failed", { message: error instanceof Error ? error.message : String(error) });
		}

		/**
		 * Pause glyph, drawn on the shell's icon contract.
		 *
		 * The shell's own `IconPauseOutlineRegular` lives in
		 * `@deepseek-ai/dsh-client-ui-primitives`, which cannot be required from a
		 * plugin bundle (no boot-graph row), so the two bars are drawn here:
		 * 16px box, `fill:none`, 1px `currentColor` — same contract as the speaker.
		 */
		function PauseArtwork() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
				h("rect", { x: 5.4, y: 3.6, width: 1.9, height: 8.8, rx: 0.5, stroke: "currentColor", strokeWidth: 1 }),
				h("rect", { x: 8.7, y: 3.6, width: 1.9, height: 8.8, rx: 0.5, stroke: "currentColor", strokeWidth: 1 }),
			);
		}

		/**
		 * Speaker glyph.
		 *
		 * The shell ships 377 icons and none of them is a speaker, so the cone is
		 * drawn here — but on the shell's exact icon contract (16px box, `fill:none`,
		 * 1px `currentColor` stroke) so it reads as one of the family.
		 */
		function SpeakerArtwork({ state }) {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
				h("path", {
					d: "M8.4 2.3 5 5.1H2.6a.8.8 0 0 0-.8.8v4.2a.8.8 0 0 0 .8.8H5l3.4 2.8a.55.55 0 0 0 .9-.43V2.73a.55.55 0 0 0-.9-.43Z",
					stroke: "currentColor",
					strokeWidth: 1,
					strokeLinejoin: "round",
				}),
				state === "loading"
					? h("circle", { cx: 12.3, cy: 8, r: 1.7, stroke: "currentColor", strokeWidth: 1, strokeDasharray: "1.6 1.6" })
					: h("path", { d: "M11.4 6.1a2.7 2.7 0 0 1 0 3.8M13.2 4.3a5.2 5.2 0 0 1 0 7.4", stroke: "currentColor", strokeWidth: 1, strokeLinecap: "round" }),
			);
		}

		/**
		 * Reveal the action row and move one button after the branch button.
		 *
		 * Two things the slot contract does not give us:
		 *
		 *  - The shell hides the whole action row (`opacity: 0`) until the row is
		 *    hovered. That belongs to the row, not to this button, so keeping one
		 *    button lit means revealing the row from here.
		 *  - `extraActions` renders *before* the branch button, and reordering the
		 *    row with CSS `order` would be fragile — the row also holds a tooltip
		 *    wrapper, a visually-hidden reason and the end-info cluster. Moving our
		 *    own node is one DOM operation on elements we can see.
		 *
		 * Extracted and parameterised so it can be exercised without React or a real
		 * DOM; it degrades to "leave the button where it is" whenever the shell's
		 * structure differs from what we expect.
		 *
		 * @param button - the read-aloud button element, or null before mount.
		 * @param labels - candidate accessible names of the branch button.
		 * @returns a short outcome string, for diagnostics.
		 */
		function placeAfterBranch(button, labels) {
			if (button === null || button === undefined) return "no-button";
			try {
				const row = button.parentElement;
				if (row === null || row === undefined) return "no-row";
				if (row.style !== undefined && row.style !== null) {
					// Undo the shell's hover-only fade without touching its class.
					row.style.opacity = "";
				}
				const siblings = Array.from(row.children ?? []);
				/*
				 * Already done? The button was moved out of its original slot, so it
				 * may no longer be among the row's *current* children — checking only
				 * that list would report "no branch" on the second run and never reach
				 * the idempotent path below.
				 */
				const branchBefore = button.previousElementSibling;
				if (
					branchBefore !== null
					&& branchBefore !== undefined
					&& typeof branchBefore.getAttribute === "function"
					&& siblings.includes(branchBefore)
				) {
					const previousLabel = branchBefore.getAttribute("aria-label");
					const nested = typeof branchBefore.querySelector === "function" ? branchBefore.querySelector("button") : null;
					const nestedLabel = nested !== null && typeof nested.getAttribute === "function" ? nested.getAttribute("aria-label") : null;
					const known = (labels ?? []).filter((label) => typeof label === "string" && label !== "" && !/^(message|action)\./.test(label));
					if (known.includes(previousLabel) || known.includes(nestedLabel)) return "already-placed";
				}
				// An unresolved translation key is echoed back verbatim; ignore those
				// so a missing dictionary entry cannot match the wrong button.
				const wanted = (labels ?? []).filter(
					(label) => typeof label === "string" && label !== "" && !/^(message|action)\./.test(label),
				);
				if (wanted.length === 0) return "no-label";
				const branch = siblings.find((node) => {
					if (node === null || node === undefined) return false;
					const nested = typeof node.querySelector === "function" ? node.querySelector("button") : null;
					const target = nested ?? node;
					const label = typeof target.getAttribute === "function" ? target.getAttribute("aria-label") : null;
					return label !== null && label !== undefined && wanted.includes(label);
				});
				if (branch === undefined || branch === null || branch === button) return "no-branch";
				if (typeof branch.insertAdjacentElement !== "function") return "no-insert";
				branch.insertAdjacentElement("afterend", button);
				return "placed";
			} catch (error) {
				return `failed:${error instanceof Error ? error.message : String(error)}`;
			}
		}

		/**
		 * Describe a value's shape, so the store can be read back from the host log.
		 *
		 * The snapshot shape is the one thing about this plugin that cannot be read
		 * out of the shell's source with certainty — it is assembled at run time.
		 * Rather than guess a fourth time, report what is actually there.
		 */
		function describeShape(value, depth) {
			const level = depth === undefined ? 0 : depth;
			if (value === null) return "null";
			if (value === undefined) return "undefined";
			const type = typeof value;
			if (type === "string") return `string(${value.length})`;
			if (type === "number" || type === "boolean") return `${type}(${String(value)})`;
			if (type === "function") return "function";
			if (level >= 2) return `${type}${Array.isArray(value) ? `[${value.length}]` : ""}`;
			if (Array.isArray(value)) {
				return `array[${value.length}]${value.length === 0 ? "" : `{0:${describeShape(value[0], level + 1)}}`}`;
			}
			return `object{${Object.keys(value).slice(0, 24).join(",")}}`;
		}

		/** One node's shape: its kind plus the field names that matter. */
		function describeNode(node) {
			if (node === null || typeof node !== "object") return describeShape(node);
			return {
				kind: node.kind === undefined ? null : node.kind,
				keys: Object.keys(node).slice(0, 16),
				data: node.data === undefined ? "no-data" : describeShape(node.data, 1),
				blocks: Array.isArray(node.blocks) ? `array[${node.blocks.length}]` : typeof node.blocks,
			};
		}

		/**
		 * Report how chat nodes can actually be reached, once per session.
		 *
		 * Measured on this install: `snapshot.nodes` is neither a Map nor an array
		 * but a purpose-built container (`byKey`, `turnKinds`, `valuesCache`, …), so
		 * probing for `values()`/`size` found nothing. This enumerates what the
		 * container really exposes and which accessor yields a list.
		 */
		function reportStoreShape(snapshot, where) {
			try {
				if (snapshot === null || snapshot === undefined) {
					diag(`${where}-shape`, { snapshot: describeShape(snapshot) });
					return;
				}
				const container = snapshot.nodes;
				let probe = null;
				if (container !== null && container !== undefined && typeof container === "object") {
					// Own keys plus the prototype chain: the accessor is likely a method.
					const names = new Set(Object.keys(container).slice(0, 24));
					let proto = Object.getPrototypeOf(container);
					let depth = 0;
					while (proto !== null && proto !== Object.prototype && depth < 3) {
						for (const name of Object.getOwnPropertyNames(proto)) {
							if (name !== "constructor") names.add(name);
						}
						proto = Object.getPrototypeOf(proto);
						depth += 1;
					}
					const described = [];
					for (const name of names) {
						let type = "?";
						try {
							type = typeof container[name];
						} catch {
							type = "getter-threw";
						}
						described.push(`${name}:${type}`);
					}
					// Try the plausible roads to the nodes and report which yields a list.
					const countOf = (value) => {
						if (value === null || value === undefined) return "nil";
						if (Array.isArray(value)) return `array[${value.length}]`;
						if (typeof value.values === "function") {
							try {
								return `values[${Array.from(value.values()).length}]`;
							} catch {
								return "values-threw";
							}
						}
						if (typeof value.size === "number") return `size=${value.size}`;
						return `object{${Object.keys(value).slice(0, 8).join(",")}}`;
					};
					const attempts = {};
					for (const road of ["values", "all", "list", "toArray", "byKey"]) {
						try {
							const value = typeof container[road] === "function" ? container[road]() : container[road];
							attempts[road] = countOf(value);
						} catch (error) {
							attempts[road] = `threw:${error instanceof Error ? error.message : String(error)}`;
						}
					}
					probe = { members: described.slice(0, 40), attempts };
				}
				const legacy = snapshot.legacy;
				const legacyNodes = legacy !== null && typeof legacy === "object" ? legacy.nodes : undefined;
				diag(`${where}-shape`, {
					topKeys: Object.keys(snapshot).slice(0, 24),
					container: describeShape(container, 1),
					probe,
					legacy: legacy === undefined ? "absent" : describeShape(legacy, 1),
					legacyNodes: Array.isArray(legacyNodes) ? `array[${legacyNodes.length}]` : describeShape(legacyNodes),
					order: Array.isArray(snapshot.order) ? `array[${snapshot.order.length}]` : describeShape(snapshot.order),
				}, { once: true });
			} catch (error) {
				diag(`${where}-shape-failed`, { message: error instanceof Error ? error.message : String(error) });
			}
		}

		/**
		 * Call a chat selector defensively.
		 *
		 * Returns `undefined` on failure so callers can distinguish "the hook is
		 * unusable" from "the store has no such value", and reports which it was.
		 */
		function safeSelect(useChat, selector, where) {
			if (typeof useChat !== "function") {
				diag(`${where}-no-hook`, { hookType: typeof useChat });
				return undefined;
			}
			try {
				return useChat(selector);
			} catch (error) {
				diag(`${where}-threw`, { message: error instanceof Error ? error.message : String(error) });
				return undefined;
			}
		}

		/**
		 * Read the addressed message's text.
		 *
		 * One hook call returning a primitive, which is the shape the shell's own
		 * plugins use — a selector that builds a fresh object can defeat the store's
		 * change comparison and never re-render.
		 */
		function useAddressedText(useChat, messageId, where) {
			if (messageId === undefined || messageId === null) {
				// Once per name: this runs on every render, and the driver legitimately
				// has no id until a reply exists — reporting each time flooded the log
				// with hundreds of identical lines.
				diag(`${where}-no-id`, {}, { once: true });
				return "";
			}
			const value = safeSelect(useChat, (snapshot) => selectText(snapshot, messageId), where);
			if (value === undefined) {
				// The hook itself failed; report the snapshot shape through it once.
				reportStoreShape(safeSelect(useChat, (snapshot) => snapshot, `${where}-identity`), `${where}-unreadable`);
				return "";
			}
			return typeof value === "string" ? value : "";
		}

		/**
		 * Report what the nodes themselves look like, once per session.
		 *
		 * The container is measured; the node shape inside it is not. `kind` values
		 * and the field carrying the text are the last unknowns between here and a
		 * working read, so they are reported rather than guessed.
		 */
		function reportNodeShape(snapshot, where) {
			try {
				const nodes = snapshotNodes(snapshot);
				if (nodes.length === 0) {
					diag(`${where}-nodes`, { count: 0 }, { once: true });
					return;
				}
				const counts = new Map();
				for (const node of nodes) {
					const kind = node !== null && typeof node === "object" ? String(node.kind) : `?${typeof node}`;
					counts.set(kind, (counts.get(kind) ?? 0) + 1);
				}
				// Detail for the last few assistant-looking nodes.
				const interesting = nodes
					.filter((node) => node !== null && typeof node === "object" && /assistant|text|message|step/i.test(String(node.kind)))
					.slice(-3);
				const detail = interesting.map((node) => {
					const data = node.data;
					const fields = data !== null && typeof data === "object" ? Object.keys(data).slice(0, 20) : null;
					// Look for anything string-shaped that could be the reply text.
					const candidates = [];
					if (data !== null && typeof data === "object") {
						for (const [key, value] of Object.entries(data)) {
							if (typeof value === "string" && value.length > 0) candidates.push(`${key}:string(${value.length})`);
							if (Array.isArray(value)) candidates.push(`${key}:array[${value.length}]`);
						}
					}
					return { kind: String(node.kind), dataFields: fields, candidates, blocksType: Array.isArray(node.blocks) ? `array[${node.blocks.length}]` : typeof node.blocks };
				});
				diag(`${where}-nodes`, {
					count: nodes.length,
					kinds: Object.fromEntries(counts),
					detail,
				}, { once: true });
			} catch (error) {
				diag(`${where}-nodes-failed`, { message: error instanceof Error ? error.message : String(error) });
			}
		}

		/** The per-message read-aloud button in the assistant action strip. */
		function ReadAloudAction(props) {
			const { messageId, useChat, t } = props;
			// Report before anything can throw, so "the button never appeared" and
			// "the button appeared but found no text" stay distinguishable.
			diag("action-render", { messageId: messageId ?? null, hasHook: typeof useChat === "function" });
			const text = useAddressedText(useChat, messageId, "action");
			// A null return below is indistinguishable from "the slot never rendered
			// this component", so record why the text came back empty.
			if (text.trim() === "") {
				const probe = safeSelect(useChat, (snapshot) => snapshot, "action-probe");
				reportStoreShape(probe, "action-empty");
				reportNodeShape(probe, "action-empty");
			}
			const [state, setState] = react.useState("idle");
			const [failure, setFailure] = react.useState(null);
			const alive = react.useRef(true);
			const buttonRef = react.useRef(null);
			// The branch button's accessible name is the shell's localized "branch"
			// label. Read it from the bundle at run time rather than hard-coding a
			// string that would break the moment the locale changes.
			const branchLabels = [t("message.branch"), t("action.branch")];

			react.useEffect(
				() => () => {
					alive.current = false;
				},
				[],
			);

			/** Reveal the row and sit the button after the branch button. */
			react.useEffect(() => {
				diag("action-placement", {
					messageId: messageId ?? null,
					outcome: placeAfterBranch(buttonRef.current, branchLabels),
				});
			}, [messageId, t]);

			// The player owns playback, so mirror its state instead of guessing.
			react.useEffect(
				() => player.subscribe(() => {
					if (!alive.current) return;
					if (player.playingFor(text)) setState("playing");
					else if (player.busy && player.currentKey === text) setState("loading");
					else setState("idle");
				}),
				[text],
			);

			const words = t("words.code") !== "words.code" ? {
				link: t("words.link"),
				path: t("words.path"),
				id: t("words.id"),
				code: t("words.code"),
				codeBlock: t("words.codeBlock"),
			} : WORDS.zh;

			if (text.trim() === "") return null;

			const onClick = () => {
				diag("button-click", { messageId, state, chars: text.length });
				if (state === "playing" || state === "loading") {
					player.stop();
					setState("idle");
					return;
				}
				setFailure(null);
				setState("loading");
				player.play(text, words).then(
					() => { diag("button-played", { messageId }); },
					(error) => {
						diag("button-failed", { messageId, message: error instanceof Error ? error.message : String(error) });
						if (!alive.current) return;
						setState("idle");
						setFailure(describeFailure(error, t));
					},
				);
			};

			const label = state === "idle" ? t("action.speak") : t("action.stop");
			// While audio plays the shell's own Pause glyph reads as "press to stop",
			// While audio plays a pause glyph reads as "press to stop", matching how
			// the shell draws its own transport controls.
			const glyph = state === "playing" ? h(PauseArtwork, {}) : h(SpeakerArtwork, { state });
			return h(
				"button",
				{
					type: "button",
					ref: buttonRef,
					className: CSS.action,
					title: failure ?? label,
					"aria-label": failure ?? label,
					"data-active": state === "playing" || state === "loading" || undefined,
					"data-failed": failure !== null || undefined,
					disabled: state === "loading",
					onClick,
				},
				glyph,
			);
		}

		/** Turn a host error into a sentence the user can act on. */
		function describeFailure(error, t) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("voice-required")) return t("error.voiceRequired");
			if (message.includes("reference-audio-required")) return t("error.referenceRequired");
			// The host names the path it could not open; that is the one detail that
			// tells the user which preset is broken, so pass it through verbatim
			// instead of collapsing it into a generic failure.
			if (message.includes("reference audio not found")) return message;
			if (message.includes("fetch") || message.includes("Failed to fetch")) return t("error.engineDown");
			return message === "" ? t("error.generic") : message;
		}

		/** The auto-read toggle in the composer tool row. */
		function AutoReadToggle(props) {
			const { t } = props;
			const [enabled, setEnabled] = react.useState(autoReadEnabled());
			react.useEffect(() => subscribeAutoRead(() => setEnabled(autoReadEnabled())), []);
			/**
			 * Flip the switch, then verify the write actually landed.
			 *
			 * The button's colour comes from component state while the feature
			 * reads `localStorage`; when storage is unavailable the two disagree
			 * and the toggle looks on while auto-read stays off. The button only
			 * reports success when the persisted value really changed.
			 */
			const flip = () => {
				const next = !autoReadEnabled();
				setAutoRead(next);
				const persisted = autoReadEnabled();
				diag("toggle", { want: next, persisted, storageOk: persisted === next });
				setEnabled(persisted);
			};
			const label = enabled ? t("toggle.on") : t("toggle.off");
			return h(
				"button",
				{
					type: "button",
					className: CSS.toggle,
					title: label,
					"aria-label": label,
					"aria-pressed": enabled,
					"data-active": enabled || undefined,
					onClick: flip,
				},
				h(SpeakerArtwork, { state: enabled ? "playing" : "idle" }),
			);
		}

		/** Shared visual language for the settings page rows. */
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 40, padding: "6px 0" };
		const inputStyle = {
			boxSizing: "border-box",
			width: "100%",
			height: 32,
			padding: "0 10px",
			font: "inherit",
			fontSize: 13,
			color: PRIMARY_COLOR,
			background: CARD_FILL,
			border: `0.5px solid ${BORDER_COLOR}`,
			borderRadius: 8,
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minWidth: 64,
			height: 32,
			padding: "0 14px",
			font: "inherit",
			fontSize: 13,
			color: PRIMARY_COLOR,
			background: "none",
			border: `0.5px solid ${BORDER_COLOR}`,
			borderRadius: 8,
			cursor: "pointer",
		};
		const fieldStyle = { display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" };
		const captionStyle = { color: LABEL_COLOR, fontSize: 12, lineHeight: "18px" };

		/** A labelled text input bound to the draft settings. */
		function Field({ label, value, placeholder, hint, onChange }) {
			return h(
				"label",
				{ style: fieldStyle },
				h("span", { style: { fontSize: 13, color: PRIMARY_COLOR } }, label),
				h("input", {
					type: "text",
					value: value ?? "",
					placeholder: placeholder ?? "",
					style: inputStyle,
					onChange: (event) => onChange(event.target.value),
				}),
				hint ? h("span", { style: captionStyle }, hint) : null,
			);
		}

		/**
		 * A picker for one trained model file.
		 *
		 * Offers what the checkout holds, but stays a free-text field as well: a
		 * model may live outside the discovered directories, and removing that
		 * escape hatch would make those unreachable.
		 */
		function ModelPicker({ label, hint, value, options, onChange, t }) {
			const known = options.some((option) => option.path === value);
			return h(
				"div",
				{ style: fieldStyle },
				h("span", { style: { fontSize: 13, color: PRIMARY_COLOR } }, label),
				options.length > 0
					? h("select", {
						value: known ? value : "",
						style: { ...inputStyle, width: "100%" },
						onChange: (event) => onChange(event.target.value),
						children: [
							h("option", { key: "", value: "" }, t("settings.pickModel")),
						].concat(
							options.map((option) => h("option", { key: option.path, value: option.path }, `${option.path}${option.version ? `  [${option.version}]` : ""}`)),
						),
					})
					: null,
				h("input", {
					type: "text",
					value: value ?? "",
					placeholder: options.length > 0 ? "" : "GPT_weights/your-model.ckpt",
					style: inputStyle,
					onChange: (event) => onChange(event.target.value),
				}),
				hint ? h("span", { style: captionStyle }, hint) : null,
			);
		}

		/** The full settings page: engine, voice presets, playback, health. */
		function SovitsSettings(props) {
			const { t } = props;
			const [draft, setDraft] = react.useState(null);
			const [models, setModels] = react.useState(null);
			const [health, setHealth] = react.useState(null);
			const [status, setStatus] = react.useState("");
			const [volume, setVolumeState] = react.useState(getVolume());
			const [speed, setSpeedState] = react.useState(getSpeed());
			const [autoRead, setAutoReadState] = react.useState(autoReadEnabled());
			const [probing, setProbing] = react.useState(false);
			const alive = react.useRef(true);

			react.useEffect(
				() => () => {
					alive.current = false;
					player.stop();
				},
				[],
			);

			const refresh = react.useCallback(async () => {
				setProbing(true);
				try {
					const state = await player.loadState();
					if (!alive.current) return;
					if (state.settings !== null) setDraft(state.settings);
					setHealth(state.health);
					setModels(state.models);
					setStatus("");
				} catch (error) {
					if (!alive.current) return;
					setStatus(error instanceof Error ? error.message : String(error));
				} finally {
					if (alive.current) setProbing(false);
				}
			}, []);

			react.useEffect(() => {
				void refresh();
			}, [refresh]);

			react.useEffect(() => subscribeAutoRead(() => setAutoReadState(autoReadEnabled())), []);

			if (draft === null) {
				return h("div", { style: { padding: "8px 0", color: LABEL_COLOR, fontSize: 13 } }, t("settings.loading"));
			}

			const voices = Array.isArray(draft.voices) ? draft.voices : [];
			const patchVoice = (index, patch) => {
				const next = voices.map((voice, at) => (at === index ? { ...voice, ...patch } : voice));
				setDraft({ ...draft, voices: next });
			};
			const removeVoice = (index) => {
				setDraft({ ...draft, voices: voices.filter((_, at) => at !== index) });
			};
			const addVoice = () => {
				setDraft({ ...draft, voices: [...voices, { name: t("settings.newVoice"), gptWeights: "", sovitsWeights: "", refAudioPath: "", promptText: "", promptLang: draft.textLang || "zh" }] });
			};

			const save = async () => {
				setStatus(t("settings.saving"));
				try {
					const saved = await player.saveSettings({
						serverUrl: draft.serverUrl,
						engineRoot: draft.engineRoot,
						defaultVoice: draft.defaultVoice,
						textLang: draft.textLang,
						speed: draft.speed,
						sampleSteps: draft.sampleSteps,
						voices: draft.voices,
					});
					if (!alive.current) return;
					if (saved !== null) setDraft(saved);
					const state = await player.loadState();
					if (!alive.current) return;
					setHealth(state.health);
					setModels(state.models);
					setStatus(t("settings.saved"));
				} catch (error) {
					if (!alive.current) return;
					setStatus(error instanceof Error ? error.message : String(error));
				}
			};

			const previewVoice = () => {
				const sample = t("settings.sample");
				setStatus(t("settings.speaking"));
				player
					.preview(sample, WORDS[t("settings.wordsLang") === "en" ? "en" : "zh"])
					.then(
						() => { if (alive.current) setStatus(""); },
						(error) => { if (alive.current) setStatus(describeFailure(error, t)); },
					);
			};

			const running = health !== null && health.running === true;

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 14, fontSize: 13, lineHeight: "22px", color: PRIMARY_COLOR } },

				// Engine
				h(
					"div",
					{ style: { border: `0.5px solid ${CARD_STROKE}`, borderRadius: 16, background: CARD_FILL, padding: "12px 16px" } },
					h("div", { style: rowStyle },
						h("span", null, t("settings.engine")),
						h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
							h("span", { style: { color: running ? "#22a06b" : DANGER_COLOR } }, running ? t("settings.engineUp") : t("settings.engineDown")),
							h("button", { type: "button", style: buttonStyle, disabled: probing, onClick: () => void refresh() }, probing ? t("settings.probing") : t("settings.probe")),
						),
					),
					h(Field, {
						label: t("settings.serverUrl"),
						value: draft.serverUrl,
						placeholder: "http://127.0.0.1:9880",
						hint: t("settings.serverUrlHint"),
						onChange: (value) => setDraft({ ...draft, serverUrl: value }),
					}),
					h(Field, {
						label: t("settings.engineRoot"),
						value: draft.engineRoot,
						placeholder: "D:\\GPT-SoVITS",
						hint: t("settings.engineRootHint"),
						onChange: (value) => setDraft({ ...draft, engineRoot: value }),
					}),
					health && health.detail ? h("div", { style: captionStyle }, `${t("settings.detail")}: ${health.detail}`) : null,
				),

				// Voice presets
				h(
					"div",
					{ style: { border: `0.5px solid ${CARD_STROKE}`, borderRadius: 16, background: CARD_FILL, padding: "12px 16px" } },
					h("div", { style: rowStyle },
						h("span", null, t("settings.voices")),
						h("button", { type: "button", style: buttonStyle, onClick: addVoice }, t("settings.addVoice")),
					),
					voices.length === 0 ? h("div", { style: captionStyle }, t("settings.noVoices")) : null,
					models === null
						? null
						: h("div", { style: captionStyle },
							models.engineRoot === ""
								? t("settings.noEngine")
								: `${t("settings.modelsFound")} ${models.engineRoot} — ${models.gpt.length} GPT / ${models.sovits.length} SoVITS`,
						),
					voices.map((voice, index) =>
						h(
							"div",
							{ key: `voice-${index}`, style: { borderTop: `0.5px solid ${CARD_STROKE}`, marginTop: 8, paddingTop: 8 } },
							h(Field, {
								label: t("settings.voiceName"),
								value: voice.name,
								hint: t("settings.voiceNameHint"),
								onChange: (value) => patchVoice(index, { name: value }),
							}),
							/*
							 * The two trained models are picked from what the checkout
							 * actually holds. They are global engine state, so a preset
							 * is a (GPT, SoVITS, reference clip) triple, not one audio file.
							 */
							h(ModelPicker, {
								label: t("settings.gptWeights"),
								hint: t("settings.gptWeightsHint"),
								value: voice.gptWeights,
								options: models === null ? [] : models.gpt,
								onChange: (value) => patchVoice(index, { gptWeights: value }),
								t,
							}),
							h(ModelPicker, {
								label: t("settings.sovitsWeights"),
								hint: t("settings.sovitsWeightsHint"),
								value: voice.sovitsWeights,
								options: models === null ? [] : models.sovits,
								onChange: (value) => patchVoice(index, { sovitsWeights: value }),
								t,
							}),
							h(Field, {
								label: t("settings.refAudio"),
								value: voice.refAudioPath,
								placeholder: "D:\\GPT-SoVITS\\ref\\voice.wav",
								hint: t("settings.refAudioHint"),
								onChange: (value) => patchVoice(index, { refAudioPath: value }),
							}),
							h(Field, {
								label: t("settings.promptText"),
								value: voice.promptText,
								hint: t("settings.promptTextHint"),
								onChange: (value) => patchVoice(index, { promptText: value }),
							}),
							h("div", { style: rowStyle },
								h("span", null, t("settings.promptLang")),
								h("select", {
									value: voice.promptLang || "zh",
									style: { ...inputStyle, width: 140 },
									onChange: (event) => patchVoice(index, { promptLang: event.target.value }),
									children: (["zh", "en", "ja", "ko", "yue"]).map((code) => h("option", { key: code, value: code }, code)),
								}),
							),
							h("div", { style: { display: "flex", justifyContent: "flex-end", paddingTop: 4 } },
								h("button", { type: "button", style: { ...buttonStyle, color: DANGER_COLOR }, onClick: () => removeVoice(index) }, t("settings.removeVoice")),
							),
						),
					),
				),

				// Playback
				h(
					"div",
					{ style: { border: `0.5px solid ${CARD_STROKE}`, borderRadius: 16, background: CARD_FILL, padding: "12px 16px" } },
					h("div", { style: rowStyle },
						h("span", null, t("settings.autoRead")),
						h("input", {
							type: "checkbox",
							checked: autoRead,
							onChange: (event) => { setAutoRead(event.target.checked); setAutoReadState(event.target.checked); },
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.defaultVoice")}`),
						h("select", {
							value: draft.defaultVoice || "",
							style: { ...inputStyle, width: 200 },
							onChange: (event) => setDraft({ ...draft, defaultVoice: event.target.value }),
							children: [h("option", { key: "", value: "" }, t("settings.firstVoice"))].concat(
								voices.map((voice) => h("option", { key: voice.name, value: voice.name }, voice.name)),
							),
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.textLang")}`),
						h("select", {
							value: draft.textLang || "zh",
							style: { ...inputStyle, width: 140 },
							onChange: (event) => setDraft({ ...draft, textLang: event.target.value }),
							children: (["zh", "en", "ja", "ko", "yue", "auto"]).map((code) => h("option", { key: code, value: code }, code)),
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.speed")} (${Number(draft.speed ?? 1).toFixed(2)}×)`),
						h("input", {
							type: "range",
							min: 0.5,
							max: 2,
							step: 0.05,
							value: draft.speed ?? 1,
							style: { width: 200 },
							onChange: (event) => setDraft({ ...draft, speed: Number(event.target.value) }),
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.sampleSteps")} (${draft.sampleSteps ?? 32})`),
						h("input", {
							type: "range",
							min: 4,
							max: 64,
							step: 4,
							value: draft.sampleSteps ?? 32,
							style: { width: 200 },
							onChange: (event) => setDraft({ ...draft, sampleSteps: Number(event.target.value) }),
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.volume")} (${Math.round(volume * 100)}%)`),
						h("input", {
							type: "range",
							min: 0,
							max: 1,
							step: 0.05,
							value: volume,
							style: { width: 200 },
							onChange: (event) => { setVolume(Number(event.target.value)); setVolumeState(Number(event.target.value)); },
						}),
					),
					h("div", { style: rowStyle },
						h("span", null, `${t("settings.playbackSpeed")} (${speed.toFixed(2)}×)`),
						h("input", {
							type: "range",
							min: 0.5,
							max: 2,
							step: 0.05,
							value: speed,
							disabled: !speedSupported(),
							style: { width: 200 },
							onChange: (event) => { setSpeed(Number(event.target.value)); setSpeedState(Number(event.target.value)); },
						}),
					),
					!speedSupported() ? h("div", { style: captionStyle }, t("settings.playbackSpeedUnsupported")) : null,
					h("div", { style: captionStyle }, t("settings.sampleStepsHint")),
				),

				// Actions
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10 } },
					h("span", { style: { ...captionStyle, flex: 1 } }, status),
					h("button", { type: "button", style: buttonStyle, onClick: previewVoice }, t("settings.preview")),
					h("button", { type: "button", style: buttonStyle, onClick: () => player.stop() }, t("settings.stop")),
					h("button", { type: "button", style: { ...buttonStyle, fontWeight: 500 }, onClick: () => void save() }, t("settings.save")),
				),
			);
		}

		// ────────────────────────────────────────────────────────────────
		// Auto-read: speak each new reply exactly once.
		// ────────────────────────────────────────────────────────────────

		/**
		 * Report one client-side decision to the host log.
		 *
		 * The browser half is not inspectable from the host, and "auto-read is
		 * silent" has several causes that look identical from outside — the toggle
		 * being off, the reply already having been read, the driver not being the
		 * one that owns the newest reply. Each decision point therefore reports
		 * why it did or did not speak.
		 *
		 * Reports are line-rate limited per event name: a component that renders
		 * on every frame would otherwise flood the host with thousands of writes
		 * (and a synchronous file append per report) while telling us nothing new.
		 */
		const DIAG_SEEN = new Set();
		/** Every report this page sent, in order; read by the offline checks. */
		const DIAG_EVENTS = [];
		function diag(event, detail, options) {
			try {
				const once = options !== undefined && options.once === true;
				if (once && DIAG_SEEN.has(event)) return;
				DIAG_SEEN.add(event);
				DIAG_EVENTS.push({ event, detail });
				void fetch(`${API}?action=diag`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ event, detail }),
					keepalive: true,
				}).catch(() => {});
			} catch { /* diagnostics must never break playback */ }
		}

		/**
		 * The locale service, captured on mount.
		 *
		 * The components that read text run outside `apply`, so they cannot close
		 * over its `ctx`.
		 */
		let localeService = null;

		/** Replacement words for the language the UI is currently in. */
		function wordsFor() {
			const active = localeService !== null ? localeService.getLocale().active : "zh";
			return active === "en" ? WORDS.en : WORDS.zh;
		}

		/**
		 * The newest speakable reply's id, read through the hook.
		 *
		 * One hook call returning a primitive — the shape the shell's own plugins
		 * use. `useChat.getState()` is deliberately not used: measured in this
		 * shell it is absent, and reading the store that way returned null.
		 */
		function safeLatest(useChat) {
			const picked = safeSelect(useChat, (snapshot) => selectLatestMessageId(snapshot), "driver");
			return typeof picked === "string" && picked !== "" ? picked : null;
		}

		/**
		 * Replies already claimed for speaking, shared by every driver copy.
		 *
		 * Module-level on purpose: the shell mounts one driver per turn, so
		 * per-instance state cannot coordinate them, and the player is
		 * single-channel — the first copy to claim a reply is the only one that
		 * may speak it.
		 */
		const CLAIMED = new Set();

		/** How many driver copies are currently mounted, for diagnostics. */
		let CLIENT_DRIVERS = 0;

		/**
		 * One auto-read driver per turn.
		 *
		 * `conversation.chat.turnTail` is a list slot: the shell renders it once
		 * for every turn and hands each occurrence an opaque `turn` value (an
		 * object, not a number — measured, not assumed). So the driver is mounted
		 * N times, and deciding "the newest reply should be read" in each copy
		 * would make N of them race for one single-channel player.
		 *
		 * Rather than decode that opaque prop, the copies cooperate through a
		 * module-level claim set. Every copy reads the same "newest reply" from
		 * the store, so whichever reaches the effect first claims it and speaks,
		 * and the rest see it as claimed. That is exactly the single-channel
		 * semantics the player already has, so no copy needs to know its turn.
		 */
		function AutoReadDriver(props) {
			const { useChat } = props;
			/*
			 * Every hook runs unconditionally, before any early return.
			 *
			 * Returning before `useChat` would break the rules of hooks: React
			 * throws, the error boundary swallows it, and the driver silently never
			 * mounts — which is precisely how this component was invisible.
			 */
			const spoken = react.useRef(new Set());
			const ready = react.useRef(false);
			const latest = safeLatest(useChat);
			// The text is read here, during render, so the hook subscribes and the
			// effect below only decides. (`useChat.getState()` returned null in this
			// shell, so the store is only reachable through the hook.)
			const latestText = useAddressedText(useChat, latest, "driver-text");
			// `see-null` in the log says the selector found nothing; this says why.
			if (latest === null || latest === undefined) {
				const probe = safeSelect(useChat, (snapshot) => snapshot, "driver-probe");
				reportStoreShape(probe, "driver-empty");
				reportNodeShape(probe, "driver-empty");
			}

			// One report per copy, to count how many the shell mounted without
			// flooding the log on every re-render.
			react.useEffect(() => {
				CLIENT_DRIVERS += 1;
				diag(`driver-mounted-${CLIENT_DRIVERS}`, { copies: CLIENT_DRIVERS, hasHook: typeof useChat === "function" });
				return () => {
					CLIENT_DRIVERS -= 1;
				};
			}, []);

			react.useEffect(() => {
				try {
					const raw = window.localStorage.getItem(LAST_READ_KEY);
					if (raw !== null && raw !== "") spoken.current.add(raw);
				} catch { /* storage disabled — session-only de-duplication */ }
				ready.current = true;
			}, []);

			const latestId = latest;
			/**
			 * Report what the driver can actually see, once per distinct value.
			 *
			 * This fires during render, ahead of every gate below, because "the
			 * driver never spoke" and "the driver never saw a reply" are otherwise
			 * indistinguishable in the log — and ruling out the gates is the whole
			 * point of the exercise.
			 */
			react.useEffect(() => {
				diag(`see-${String(latestId)}`, {
					latestId: latestId === undefined ? null : latestId,
					type: typeof latestId,
					ready: ready.current,
				}, { once: true });
			}, [latestId]);
			/**
			 * The reply that was already spoken when this page loaded.
			 *
			 * The *persisted* mark is the gate, not a per-instance flag: N drivers
			 * mount at once and per-instance state is not shared, so each copy would
			 * treat itself as the one that just switched auto-read on — claiming the
			 * reply without anyone ever speaking it.
			 */
			const lastRead = react.useRef(readStored(LAST_READ_KEY, ""));

			react.useEffect(() => {
				if (!ready.current) return;
				if (latestId === null || latestId === undefined) return;

				/*
				 * Report once per distinct reply, so a blocked gate is identifiable
				 * from the log alone. Without it, "never spoke" is indistinguishable
				 * between the returns below.
				 */
				diag(`gate-${latestId}`, {
					latestId,
					auto: autoReadEnabled(),
					lastRead: lastRead.current,
					claimed: CLAIMED.has(latestId),
				}, { once: true });

				/*
				 * Two ways a reply goes unspoken:
				 *
				 *  - it is the reply that was already on screen when auto-read was
				 *    switched on (the persisted mark still names it), or
				 *  - a copy of this driver already claimed it.
				 */
				if (lastRead.current === latestId) return;
				if (CLAIMED.has(latestId)) return;
				// Everything past here means "this reply is about to be spoken".
				if (!autoReadEnabled()) return;
				diag("speak", { latestId, copies: CLIENT_DRIVERS });

				// Claim it before speaking: a re-render mid-synthesis, or a sibling
				// copy, must not queue the same reply a second time.
				CLAIMED.add(latestId);
				lastRead.current = latestId;
				spoken.current.add(latestId);
				writeStored(LAST_READ_KEY, latestId);

				// A new reply barges in on the previous one instead of stacking.
				if (player.busy || player.playing) player.stop();

				const body = latestText;
				if (body.trim() === "") {
					diag("empty-text", { latestId });
					return;
				}
				player.play(body, wordsFor()).then(
					() => { diag("played", { latestId }); },
					(error) => {
						// Keep the de-duplication mark on failure: retrying on every
						// render would be worse than staying silent once.
						diag("play-failed", { latestId, message: error instanceof Error ? error.message : String(error) });
					},
				);
			}, [latestId, useChat]);

			return null;
		}

		// ────────────────────────────────────────────────────────────────
		// Plugin wiring.
		// ────────────────────────────────────────────────────────────────

		/**
		 * Mount the client half.
		 *
		 * @param ctx - Client runtime owning slots and the locale registry.
		 */
		function apply(ctx) {
			ctx.effect(() => () => player.stop(), "gpt-sovits: stop audio on unload");

			// Hand the locale service to the module-scope helpers the components use.
			localeService = ctx.locale;
			ctx.effect(() => () => {
				localeService = null;
			}, "gpt-sovits: release locale");

			ctx.slots.inject("conversation.chat.assistant-actions", () => {
				const dispose = ctx.slots.register(
					{
						name: "conversation.chat.assistant-actions",
						id: NS,
						order: 20,
						locale: NS,
						inject: () => ({ t: ctx.locale.bind(NS) }),
					},
					ReadAloudAction,
				);
				return () => {
					dispose();
					player.stop();
				};
			});

			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.turnTail",
						id: `${NS}-auto-read`,
						order: 40,
						locale: NS,
						inject: () => ({ t: ctx.locale.bind(NS) }),
					},
					AutoReadDriver,
				),
			);

			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: NS,
						order: 30,
						locale: NS,
						inject: () => ({ t: ctx.locale.bind(NS) }),
					},
					AutoReadToggle,
				),
			);

			let disposeSection = null;
			const mountSection = () => {
				if (disposeSection !== null) {
					disposeSection();
					disposeSection = null;
				}
				disposeSection = ctx.slots.register(
					{
						name: "settings.section",
						id: NS,
						order: 60,
						label: () => ctx.locale.bind(NS)("settings.label"),
						inject: () => ({ t: ctx.locale.bind(NS) }),
					},
					SovitsSettings,
				);
			};
			ctx.slots.inject("settings.section", () => {
				mountSection();
				// The page label is locale-sensitive, so remount when it changes.
				const off = ctx.on("locale/change", () => mountSection());
				return () => {
					off();
					if (disposeSection !== null) {
						disposeSection();
						disposeSection = null;
					}
				};
			});

			// Dictionaries for the settings page and the two tooltips.
			ctx.effect(() =>
				ctx.locale.register(NS, {
					zh: {
						"settings.label": "语音朗读（GPT-SoVITS）",
						"settings.loading": "正在读取设置…",
						"settings.engine": "GPT-SoVITS 引擎",
						"settings.engineUp": "运行中",
						"settings.engineDown": "未连接",
						"settings.probe": "重新检测",
						"settings.probing": "检测中…",
						"settings.serverUrl": "引擎地址",
						"settings.serverUrlHint": "api_v2.py 的监听地址，默认 http://127.0.0.1:9880",
						"settings.engineRoot": "GPT-SoVITS 检出目录",
						"settings.engineRootHint": "用于自动发现训练好的模型权重；留空则自动搜索（含各盘符根目录）",
						"settings.modelsFound": "已发现模型：",
						"settings.noEngine": "没找到 GPT-SoVITS 检出目录：请在上面填写，模型下拉框才会出现。",
						"settings.pickModel": "— 从已发现的模型中选择 —",
						"settings.gptWeights": "GPT 模型（.ckpt）",
						"settings.gptWeightsHint": "T2S 权重。朗读时若与当前引擎权重不同会自动切换（切换需重新加载，略有延迟）",
						"settings.sovitsWeights": "SoVITS 模型（.pth）",
						"settings.sovitsWeightsHint": "VITS 权重。与 GPT 模型成对使用，共同决定音色",
						"settings.detail": "详情",
						"settings.voices": "音色预设",
						"settings.addVoice": "添加音色",
						"settings.noVoices": "还没有音色。添加一个并填入参考音频路径后才能朗读。",
						"settings.newVoice": "新音色",
						"settings.voiceName": "音色名称",
						"settings.voiceNameHint": "朗读时按这个名字选择音色",
						"settings.refAudio": "参考音频路径",
						"settings.refAudioHint": "必须是引擎所在机器能读到的路径（3–10 秒清晰人声最佳）",
						"settings.promptText": "参考音频文本",
						"settings.promptTextHint": "参考音频里说的那句话。留空会让引擎先做一次识别，首次合成会明显变慢",
						"settings.promptLang": "参考音频语言",
						"settings.removeVoice": "删除",
						"settings.autoRead": "自动朗读新回复",
						"settings.defaultVoice": "默认音色",
						"settings.firstVoice": "使用第一个音色",
						"settings.textLang": "朗读文本语言",
						"settings.speed": "语速",
						"settings.sampleSteps": "采样步数",
						"settings.sampleStepsHint": "采样步数越低越快、音质略降；32 为默认，嫌慢可降到 16。",
						"settings.volume": "音量",
						"settings.playbackSpeed": "播放倍速",
						"settings.playbackSpeedUnsupported": "当前浏览器不支持保持音调的变速，播放固定为 1×。",
						"settings.preview": "试听",
						"settings.stop": "停止",
						"settings.save": "保存设置",
						"settings.saving": "保存中…",
						"settings.saved": "已保存",
						"settings.speaking": "正在合成…",
						"settings.sample": "你好，这是 GPT-SoVITS 语音朗读测试。音色与引擎均已按你的配置就绪。",
						"settings.wordsLang": "zh",
						"action.speak": "朗读这条回复",
						"action.stop": "停止朗读",
						"toggle.on": "自动朗读：已开启",
						"toggle.off": "自动朗读：已关闭",
						"words.link": "链接",
						"words.path": "路径",
						"words.id": "编号",
						"words.code": "长代码",
						"words.codeBlock": "（代码块已省略）",
						"error.voiceRequired": "还没有配置音色：请到 设置 → 语音朗读 添加音色并填写参考音频路径。",
						"error.referenceRequired": "这个音色没有填参考音频路径。",
						"error.engineDown": "连接不上 GPT-SoVITS 引擎：请确认 api_v2.py 已启动。",
						"error.generic": "朗读失败。",
					},
					en: {
						"settings.label": "Voice (GPT-SoVITS)",
						"settings.loading": "Loading settings…",
						"settings.engine": "GPT-SoVITS engine",
						"settings.engineUp": "running",
						"settings.engineDown": "unreachable",
						"settings.probe": "Check again",
						"settings.probing": "Checking…",
						"settings.serverUrl": "Engine URL",
						"settings.serverUrlHint": "Where api_v2.py listens; default http://127.0.0.1:9880",
						"settings.engineRoot": "GPT-SoVITS checkout",
						"settings.engineRootHint": "Used to discover trained model weights; leave empty to search (including each drive root)",
						"settings.modelsFound": "Models found:",
						"settings.noEngine": "No GPT-SoVITS checkout found: set it above and the model dropdowns appear.",
						"settings.pickModel": "— pick from the discovered models —",
						"settings.gptWeights": "GPT model (.ckpt)",
						"settings.gptWeightsHint": "T2S weights. Switched automatically when it differs from what the engine holds (a switch reloads, so it costs a moment)",
						"settings.sovitsWeights": "SoVITS model (.pth)",
						"settings.sovitsWeightsHint": "VITS weights. Used as a pair with the GPT model; together they define the voice",
						"settings.detail": "Detail",
						"settings.voices": "Voice presets",
						"settings.addVoice": "Add voice",
						"settings.noVoices": "No voices yet. Add one and fill in its reference audio path to read aloud.",
						"settings.newVoice": "New voice",
						"settings.voiceName": "Voice name",
						"settings.voiceNameHint": "Selected by this name when reading aloud",
						"settings.refAudio": "Reference audio path",
						"settings.refAudioHint": "Must be readable by the engine host (3–10 s of clear speech works best)",
						"settings.promptText": "Reference transcript",
						"settings.promptTextHint": "What the reference clip says. Leaving it empty makes the engine transcribe first, so the first synthesis is much slower",
						"settings.promptLang": "Reference language",
						"settings.removeVoice": "Remove",
						"settings.autoRead": "Read new replies automatically",
						"settings.defaultVoice": "Default voice",
						"settings.firstVoice": "Use the first voice",
						"settings.textLang": "Text language",
						"settings.speed": "Speech rate",
						"settings.sampleSteps": "Sampling steps",
						"settings.sampleStepsHint": "Fewer steps is faster and slightly rougher; 32 is the default, try 16 if it feels slow.",
						"settings.volume": "Volume",
						"settings.playbackSpeed": "Playback speed",
						"settings.playbackSpeedUnsupported": "This browser cannot change playback rate while preserving pitch, so playback stays at 1×.",
						"settings.preview": "Preview",
						"settings.stop": "Stop",
						"settings.save": "Save settings",
						"settings.saving": "Saving…",
						"settings.saved": "Saved",
						"settings.speaking": "Synthesizing…",
						"settings.sample": "Hello, this is a GPT-SoVITS read-aloud test. Your engine and voice are ready.",
						"settings.wordsLang": "en",
						"action.speak": "Read this reply aloud",
						"action.stop": "Stop reading",
						"toggle.on": "Auto-read: on",
						"toggle.off": "Auto-read: off",
						"words.link": "link",
						"words.path": "path",
						"words.id": "id",
						"words.code": "code",
						"words.codeBlock": " (code block omitted) ",
						"error.voiceRequired": "No voice configured yet: open Settings → Voice (GPT-SoVITS) and add a reference audio path.",
						"error.referenceRequired": "This voice has no reference audio path.",
						"error.engineDown": "Cannot reach the GPT-SoVITS engine: make sure api_v2.py is running.",
						"error.generic": "Read-aloud failed.",
					},
				}),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		/*
		 * Test seam.
		 *
		 * The components are otherwise unreachable from outside — they close over
		 * `player` and `diag`, which is exactly what needs to be checked. The shell
		 * reads only `apply`/`inject`; a static export costs nothing and lets an
		 * offline check drive the real click path instead of trusting that the
		 * wiring is right.
		 */
		exports.__test = { player, diag, CLAIMED, ReadAloudAction, AutoReadDriver, selectText, selectLatestMessageId, safeLatest, placeAfterBranch, splitIntoChunks, cleanForSpeech, blocksToText, diagEvents: DIAG_EVENTS };
		return module.exports;
	},
});
