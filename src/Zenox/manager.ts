import { EventEmitter } from 'events'
import { constants as osConstants } from 'os'
import { ActivityTracker, type ZenoxActivity } from './activity'
import type { ZenoxAuthHandle } from './auth-state'
import type { TieredCache } from './cache'
import { NetworkMonitor, type NetworkOptions } from './network'
import { assertSessionId, defaultLogger, type ZenoxLogger, type ZenoxStorage } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The few things the manager needs from a Baileys socket (kept structural so it is easy to test). */
export interface ZenoxSocketLike {
	ev: { on(event: any, listener: (...args: any[]) => void): void }
	end(error: Error | undefined): void
	authState?: { creds: { registered?: boolean } }
	requestPairingCode?(phoneNumber: string): Promise<string>
}

/** Same numbers as Baileys' `DisconnectReason`. */
export const ZX_CODE = {
	loggedOut: 401,
	forbidden: 403,
	connectionReplaced: 440,
	restartRequired: 515
} as const

export interface ReconnectOptions {
	/** reconnect automatically (default true) */
	enabled?: boolean
	/** delay before the 1st retry (default 200ms) */
	initialDelayMs?: number
	/** upper bound of the delay (default 15s) */
	maxDelayMs?: number
	/** multiplier per failed attempt (default 1.7) */
	factor?: number
	/** +-fraction of random spread so many sessions do not retry in the same instant (default 0.2) */
	jitter?: number
	/** give up after this many failed attempts in a row (default: never) */
	maxAttempts?: number
	/** reconnect after code 440 (another device took the session). Default false, it would just fight. */
	reconnectOnReplaced?: boolean
	/** delete the stored session when WhatsApp reports it as logged out (default true, the creds are dead anyway) */
	removeOnLogout?: boolean
}

export const computeReconnectDelay = (
	attempt: number,
	opts: Required<Pick<ReconnectOptions, 'initialDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'>>,
	random: () => number = Math.random
) => {
	const base = Math.min(opts.maxDelayMs, opts.initialDelayMs * Math.pow(opts.factor, Math.max(0, attempt - 1)))
	const spread = base * opts.jitter * (random() * 2 - 1)
	return Math.max(0, Math.round(base + spread))
}

export interface ProcessHookOptions {
	/** save + close sessions on SIGINT / SIGTERM / SIGHUP (default true) */
	signals?: boolean
	/** call process.exit after saving when WE are the only listener of that signal (default true) */
	exitOnSignal?: boolean
	/** 'exit' = save then exit(1) like Node does by default; 'continue' = save and keep running (default 'exit') */
	uncaughtException?: 'exit' | 'continue'
	/** default 'continue': log + save, do not crash (Baileys produces harmless rejections) */
	unhandledRejection?: 'exit' | 'continue'
	/** hard limit for the shutdown (default 8000ms) */
	shutdownTimeoutMs?: number
}

export type ZenoxStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed' | 'logged-out' | 'stopped'

export interface StartOptions<S extends ZenoxSocketLike> {
	/** called for every socket of this session, INCLUDING the ones created by auto-reconnect */
	onSocket?: (sock: S, ctx: { session: string; attempt: number }) => void | Promise<void>
	/** if the session is not registered yet, request a pairing code for this phone number (digits only) */
	pairingPhone?: string
	/** extra Baileys socket config for this session only */
	socketConfig?: Record<string, any>
}

/**
 * Optional second home for the messages this session sent (used to answer WhatsApp retry requests).
 * The in-memory map stays the fast path; this one survives restarts (e.g. backed by redis).
 */
export interface SentStore {
	get(id: string): Promise<any> | any
	set(id: string, message: any): void
}

export interface SessionCaches {
	groups: TieredCache
	sent?: SentStore
	[name: string]: any
}

export interface ZenoxManagerOptions<S extends ZenoxSocketLike> {
	/** `makeWASocket` */
	makeSocket: (config: any) => S
	createAuth: (session: string) => Promise<ZenoxAuthHandle>
	storage: ZenoxStorage
	/** builds the caches handed to Baileys; return `groups` to enable group-metadata caching */
	createCaches?: (session: string) => SessionCaches & Record<string, any>
	/** Baileys config applied to every session (version, browser, ...) */
	socketConfig?: Record<string, any> | ((session: string) => Record<string, any>)
	reconnect?: ReconnectOptions
	hooks?: boolean | ProcessHookOptions
	logger?: ZenoxLogger
	/** keep the last sent messages in memory so Baileys can answer message retries (default 500, 0 = off) */
	sentMessageCache?: number
	/** speed up `sock.groupMetadata()` with the group cache (default true) */
	cacheGroupMetadata?: boolean
	/** pause between sessions in startAll() so WhatsApp does not see a burst (default 300ms) */
	staggerMs?: number
	/**
	 * Detect "the server has no internet": reconnecting pauses (without using up `maxAttempts`) until the
	 * connection is back, then reconnects at once. `false` turns it off. Default: on.
	 */
	network?: NetworkOptions | false
	activityMaxEvents?: number
}

export interface ZenoxEventMap {
	socket: { session: string; sock: any; attempt: number }
	qr: { session: string; qr: string }
	'pairing-code': { session: string; code: string }
	open: { session: string; reconnected: boolean }
	close: { session: string; code?: number; reason?: string }
	reconnecting: { session: string; attempt: number; delayMs: number; code?: number }
	/** the server has no internet; the session waits instead of retrying blindly */
	offline: { session: string; since: number; code?: number }
	/** the internet is back, the session reconnects right now */
	online: { session: string; offlineMs: number }
	'give-up': { session: string; attempts: number }
	'logged-out': { session: string; removed: boolean }
	replaced: { session: string }
	forbidden: { session: string }
	restored: { session: string; previous?: ZenoxActivity; crashed: boolean }
	'flush-error': { session: string; err: unknown }
	shutdown: { reason: string }
}

interface Runtime<S extends ZenoxSocketLike> {
	id: string
	opts: StartOptions<S>
	status: ZenoxStatus
	sock?: S
	auth?: ZenoxAuthHandle
	activity?: ActivityTracker
	caches?: SessionCaches
	attempts: number
	everOpened: boolean
	/** set while the server has no internet */
	offlineSince?: number
	generation: number
	stopping: boolean
	timer?: ReturnType<typeof setTimeout>
	sent: Map<string, any>
}

export interface ZenoxManager<S extends ZenoxSocketLike = ZenoxSocketLike> {
	on<K extends keyof ZenoxEventMap>(event: K, listener: (payload: ZenoxEventMap[K]) => void): this
	once<K extends keyof ZenoxEventMap>(event: K, listener: (payload: ZenoxEventMap[K]) => void): this
	off<K extends keyof ZenoxEventMap>(event: K, listener: (payload: ZenoxEventMap[K]) => void): this
	emit<K extends keyof ZenoxEventMap>(event: K, payload: ZenoxEventMap[K]): boolean
}

/**
 * Runs any number of WhatsApp sessions, each with:
 *  - fast automatic reconnect (exponential backoff + jitter, instant restart after pairing)
 *  - memory-first auth state with batched saves
 *  - saved "last activity" and crash detection
 *  - save-on-exit hooks (signals, crashes, normal exit)
 */
export class ZenoxManager<S extends ZenoxSocketLike = ZenoxSocketLike> extends EventEmitter {
	private readonly runtimes = new Map<string, Runtime<S>>()
	private readonly socketHandlers: Array<NonNullable<StartOptions<S>['onSocket']>> = []
	private readonly log: ZenoxLogger
	private readonly reconnectOpts: Required<ReconnectOptions>
	private shuttingDown?: Promise<void>
	private removeHooks?: () => void
	/** internet detector (undefined when `network: false`). `zenox.network?.online` is the last known state. */
	readonly network?: NetworkMonitor

	constructor(private readonly options: ZenoxManagerOptions<S>) {
		super()
		this.log = options.logger ?? defaultLogger
		const r = options.reconnect ?? {}
		this.reconnectOpts = {
			enabled: r.enabled ?? true,
			initialDelayMs: r.initialDelayMs ?? 200,
			maxDelayMs: r.maxDelayMs ?? 15_000,
			factor: r.factor ?? 1.7,
			jitter: r.jitter ?? 0.2,
			maxAttempts: r.maxAttempts ?? Infinity,
			reconnectOnReplaced: r.reconnectOnReplaced ?? false,
			removeOnLogout: r.removeOnLogout ?? true
		}
		if (options.network !== false && options.network?.enabled !== false) {
			this.network = new NetworkMonitor(options.network ?? {}, this.log)
		}

		if (options.hooks !== false) this.installHooks(typeof options.hooks === 'object' ? options.hooks : {})
	}

	/* ------------------------------ public API ------------------------------ */

	/** Register a handler that runs for EVERY socket of EVERY session (also after reconnects). */
	onSocket(handler: NonNullable<StartOptions<S>['onSocket']>): this {
		this.socketHandlers.push(handler)
		return this
	}

	/** Start (or return) a session. Resolves when the socket is created, listen to 'open' for the connection. */
	async start(session: string, opts: StartOptions<S> = {}): Promise<S> {
		assertSessionId(session)
		if (this.shuttingDown) throw new Error('zenox: manager is shutting down')
		let rt = this.runtimes.get(session)
		// a session parked as 'stopped' (403, 440 or gave up) has a dead socket: start() must revive it, not return it
		if (rt && !rt.stopping && rt.sock && rt.status !== 'stopped') return rt.sock
		if (!rt) {
			rt = {
				id: session,
				opts,
				status: 'connecting',
				attempts: 0,
				everOpened: false,
				generation: 0,
				stopping: false,
				sent: new Map()
			}
			this.runtimes.set(session, rt)
		} else {
			rt.opts = opts
			rt.stopping = false
			rt.attempts = 0
			rt.offlineSince = undefined
			if (rt.timer) clearTimeout(rt.timer)
			rt.timer = undefined
		}

		try {
			await this.connect(rt)
		} catch (err) {
			this.runtimes.delete(session)
			throw err
		}

		return rt.sock as S
	}

	/** Start every stored session that has credentials. Returns the ids that were started. */
	async startAll(opts: StartOptions<S> = {}): Promise<string[]> {
		const started: string[] = []
		for (const id of await this.options.storage.sessions()) {
			try {
				if ((await this.options.storage.read(id, 'creds')) === null) continue
				if (this.runtimes.has(id)) continue
				await this.start(id, opts)
				started.push(id)
				if (this.options.staggerMs !== 0) await sleep(this.options.staggerMs ?? 300)
			} catch (err) {
				this.log.error({ session: id, err }, 'zenox: could not start session')
			}
		}

		return started
	}

	get(session: string): S | undefined {
		return this.runtimes.get(session)?.sock
	}

	status(session: string): ZenoxStatus | undefined {
		return this.runtimes.get(session)?.status
	}

	/** sessions running right now */
	running(): Array<{ session: string; status: ZenoxStatus }> {
		return [...this.runtimes.values()].map(r => ({ session: r.id, status: r.status }))
	}

	/** every session known to the storage (running or not) */
	stored(): Promise<string[]> {
		return this.options.storage.sessions()
	}

	/** what a session was doing (this run) and what it was doing before the last restart (`previous`) */
	activity(session: string): { current: ZenoxActivity; previous?: ZenoxActivity; crashedLastTime: boolean } | undefined {
		const a = this.runtimes.get(session)?.activity
		return a ? { current: a.current, previous: a.previous, crashedLastTime: a.crashedLastTime } : undefined
	}

	/** persist your own state with the session, e.g. `setMeta('main', { lastCommand: '.menu' })` */
	setMeta(session: string, patch: Record<string, unknown>) {
		this.runtimes.get(session)?.activity?.setMeta(patch)
	}

	/** Disconnect a session but keep its data (it stays logged in on your phone). */
	async stop(session: string, reason = 'stop'): Promise<void> {
		const rt = this.runtimes.get(session)
		if (!rt) return
		await this.stopRuntime(rt, reason)
		this.runtimes.delete(session)
	}

	/** Stop AND delete all stored data of a session. */
	async remove(session: string): Promise<void> {
		assertSessionId(session)
		const rt = this.runtimes.get(session)
		if (rt) {
			rt.stopping = true
			if (rt.timer) clearTimeout(rt.timer)
			try {
				rt.sock?.end(undefined)
			} catch {}

			rt.activity?.persist()
			if (rt.auth) await rt.auth.clear()
			else await this.options.storage.removeSession(session)
			this.runtimes.delete(session)
		} else {
			await this.options.storage.removeSession(session)
		}
	}

	/** save everything that is waiting right now */
	async flushAll(): Promise<void> {
		await Promise.all(
			[...this.runtimes.values()].map(async rt => {
				rt.activity?.persist()
				try {
					await rt.auth?.flush()
				} catch (err) {
					this.emit('flush-error', { session: rt.id, err })
				}
			})
		)
	}

	/** Blocking save for when the process is already exiting. */
	flushAllSync(): void {
		for (const rt of this.runtimes.values()) {
			try {
				rt.activity?.persist()
				rt.auth?.flushSync()
			} catch (err) {
				this.log.error({ session: rt.id, err }, 'zenox: sync flush failed')
			}
		}
	}

	/** Save, disconnect (without logging out) and close everything. Safe to call many times. */
	shutdown(reason = 'manual'): Promise<void> {
		this.shuttingDown ??= (async () => {
			this.log.info({ reason }, 'zenox: shutting down')
			await Promise.allSettled([...this.runtimes.values()].map(rt => this.stopRuntime(rt, reason)))
			this.runtimes.clear()
			await this.options.storage.close?.().catch(() => {})
			this.removeHooks?.()
			this.emit('shutdown', { reason })
		})()
		return this.shuttingDown
	}

	/** remove process listeners without shutting sessions down (mostly for tests) */
	dispose() {
		this.removeHooks?.()
	}

	/* ------------------------------ internals ------------------------------- */

	private async stopRuntime(rt: Runtime<S>, reason: string) {
		rt.stopping = true
		if (rt.timer) clearTimeout(rt.timer)
		rt.timer = undefined
		rt.status = 'stopped'
		try {
			rt.sock?.end(undefined) // NOT logout: the phone stays linked
		} catch {}

		rt.activity?.markShutdown(reason)
		rt.activity?.persist()
		await rt.auth?.close()
	}

	private async connect(rt: Runtime<S>): Promise<void> {
		if (rt.stopping) return
		rt.status = rt.attempts > 0 ? 'reconnecting' : 'connecting'

		// auth state, activity and caches are created ONCE and reused by every reconnect,
		// so a reconnect never has to reload anything from disk/redis.
		if (!rt.auth) {
			rt.auth = await this.options.createAuth(rt.id)
			rt.activity = await ActivityTracker.load(rt.auth.store, rt.id, this.options.activityMaxEvents ?? 50)
			rt.caches = this.options.createCaches?.(rt.id)
			rt.activity.record('start', { new: rt.auth.isNew })
			this.emit('restored', {
				session: rt.id,
				previous: rt.activity.previous,
				crashed: rt.activity.crashedLastTime
			})
		}

		if (rt.stopping) return
		const generation = ++rt.generation
		const auth = rt.auth
		const caches = rt.caches
		const baseConfig =
			typeof this.options.socketConfig === 'function' ? this.options.socketConfig(rt.id) : (this.options.socketConfig ?? {})
		const userConfig = { ...baseConfig, ...(rt.opts.socketConfig ?? {}) }
		const userGetMessage = userConfig.getMessage
		const userGroupCache = userConfig.cachedGroupMetadata

		const config: Record<string, any> = {
			...(caches
				? {
						msgRetryCounterCache: caches.msgRetryCounterCache,
						userDevicesCache: caches.userDevicesCache,
						callOfferCache: caches.callOfferCache,
						placeholderResendCache: caches.placeholderResendCache,
						mediaCache: caches.mediaCache
					}
				: {}),
			...userConfig,
			auth: { creds: auth.state.creds, keys: auth.state.keys },
			getMessage: async (key: any) => {
				if (userGetMessage) {
					const m = await userGetMessage(key)
					if (m) return m
				}

				if (!key?.id) return undefined
				const local = rt.sent.get(key.id)
				if (local) return local
				try {
					return (await caches?.sent?.get(key.id)) ?? undefined
				} catch (err) {
					this.log.warn({ session: rt.id, err }, 'zenox: sent-message store lookup failed')
					return undefined
				}
			}
		}
		if (caches?.groups) {
			config.cachedGroupMetadata = async (jid: string) => {
				if (userGroupCache) {
					const m = await userGroupCache(jid)
					if (m) return m
				}

				return caches.groups.get(`group:${jid}`)
			}
		}

		const sock = this.options.makeSocket(config)
		rt.sock = sock

		// ---- everything below runs synchronously after makeSocket, so no event can be missed ----
		this.wireSocket(rt, sock, generation)
		const ctx = { session: rt.id, attempt: rt.attempts }
		this.emit('socket', { session: rt.id, sock, attempt: rt.attempts })
		for (const handler of [...this.socketHandlers, ...(rt.opts.onSocket ? [rt.opts.onSocket] : [])]) {
			try {
				Promise.resolve(handler(sock, ctx)).catch(err => this.log.error({ session: rt.id, err }, 'zenox: onSocket handler failed'))
			} catch (err) {
				this.log.error({ session: rt.id, err }, 'zenox: onSocket handler failed')
			}
		}
	}

	private wireSocket(rt: Runtime<S>, sock: S, generation: number) {
		const stale = () => rt.generation !== generation || rt.sock !== sock
		const auth = rt.auth as ZenoxAuthHandle
		const activity = rt.activity as ActivityTracker
		const caches = rt.caches
		let pairingRequested = false

		sock.ev.on('creds.update', () => {
			auth.saveCreds().catch(err => {
				this.log.error({ session: rt.id, err }, 'zenox: saving credentials failed')
				this.emit('flush-error', { session: rt.id, err })
			})
		})

		sock.ev.on('connection.update', (update: any) => {
			if (stale()) return
			const { connection, lastDisconnect, qr } = update ?? {}

			if (qr) {
				this.emit('qr', { session: rt.id, qr })
				const phone = rt.opts.pairingPhone
				if (phone && !pairingRequested && !sock.authState?.creds.registered && sock.requestPairingCode) {
					pairingRequested = true
					sock
						.requestPairingCode(phone.replace(/\D/g, ''))
						.then(code => {
							activity.record('pairing-code')
							this.emit('pairing-code', { session: rt.id, code })
						})
						.catch(err => this.log.error({ session: rt.id, err }, 'zenox: requesting pairing code failed'))
				}
			}

			if (connection === 'open') {
				const reconnected = rt.everOpened
				rt.everOpened = true
				rt.attempts = 0
				rt.status = 'open'
				activity.patch({ status: 'open', lastOpenAt: Date.now(), reconnects: activity.current.reconnects + (reconnected ? 1 : 0) })
				activity.record('open', { reconnected })
				this.emit('open', { session: rt.id, reconnected })
			} else if (connection === 'close') {
				this.onClose(rt, sock, lastDisconnect)
			}
		})

		sock.ev.on('messages.upsert', (u: any) => {
			if (stale()) return
			const messages: any[] = u?.messages ?? []
			if (!messages.length) return
			const last = messages[messages.length - 1]
			activity.current.messagesSeen += messages.length
			activity.patch({ lastMessageAt: Date.now(), lastMessageJid: last?.key?.remoteJid })
			const cap = this.options.sentMessageCache ?? 500
			if (cap > 0) {
				for (const m of messages) {
					if (m?.key?.fromMe && m.key.id && m.message) {
						rt.sent.delete(m.key.id)
						rt.sent.set(m.key.id, m.message)
						try {
							caches?.sent?.set(m.key.id, m.message) // survives a restart
						} catch (err) {
							this.log.warn({ session: rt.id, err }, 'zenox: could not persist sent message')
						}
					}
				}

				while (rt.sent.size > cap) rt.sent.delete(rt.sent.keys().next().value as string)
			}
		})

		if (caches?.groups) {
			const groups = caches.groups
			sock.ev.on('groups.upsert', (list: any[]) => {
				for (const g of list ?? []) if (g?.id) groups.set(`group:${g.id}`, g)
			})
			sock.ev.on('groups.update', (list: any[]) => {
				for (const g of list ?? []) if (g?.id) groups.del(`group:${g.id}`)
			})
			sock.ev.on('group-participants.update', (u: any) => {
				if (u?.id) groups.del(`group:${u.id}`)
			})

			if (this.options.cacheGroupMetadata !== false && typeof (sock as any).groupMetadata === 'function') {
				const original = (sock as any).groupMetadata.bind(sock)
				;(sock as any).groupMetadata = (jid: string) => groups.wrap(`group:${jid}`, () => original(jid))
			}
		}
	}

	private onClose(rt: Runtime<S>, sock: S, lastDisconnect: any) {
		const code: number | undefined = lastDisconnect?.error?.output?.statusCode
		const reason: string | undefined = lastDisconnect?.error?.message
		const activity = rt.activity as ActivityTracker
		rt.status = 'closed'
		activity.patch({ status: 'closed', lastCloseAt: Date.now(), lastCloseCode: code })
		activity.record('close', { code, reason })
		this.emit('close', { session: rt.id, code, reason })
		try {
			sock.end(undefined) // release the old socket; a new one is created below
		} catch {}

		if (rt.stopping || this.shuttingDown) return

		if (code === ZX_CODE.loggedOut) {
			void this.handleLoggedOut(rt)
			return
		}

		if (code === ZX_CODE.forbidden) {
			rt.status = 'stopped'
			this.log.error({ session: rt.id }, 'zenox: WhatsApp refused the session (403), not reconnecting')
			this.emit('forbidden', { session: rt.id })
			return
		}

		if (code === ZX_CODE.connectionReplaced && !this.reconnectOpts.reconnectOnReplaced) {
			rt.status = 'stopped'
			this.emit('replaced', { session: rt.id })
			return
		}

		this.scheduleReconnect(rt, code)
	}

	private async handleLoggedOut(rt: Runtime<S>) {
		const remove = this.reconnectOpts.removeOnLogout
		rt.status = 'logged-out'
		rt.stopping = true
		this.emit('logged-out', { session: rt.id, removed: remove })
		if (remove) {
			try {
				await this.remove(rt.id)
			} catch (err) {
				this.log.error({ session: rt.id, err }, 'zenox: removing logged-out session failed')
			}
		}
	}

	private scheduleReconnect(rt: Runtime<S>, code?: number) {
		if (!this.reconnectOpts.enabled) return
		// Is the problem WhatsApp or our own connection? Only ask when the close looks network-related
		// (408 lost/timeout/ENOTFOUND..., 428 closed, 503, no code) or when retries already failed once.
		const suspect =
			code === undefined || code === 408 || code === 428 || code === 503 || (code !== ZX_CODE.restartRequired && rt.attempts >= 1)
		const monitor = this.network
		if (!monitor || !suspect) {
			this.queueReconnect(rt, code)
			return
		}

		const t0 = Date.now()
		void monitor.check().then(online => {
			if (rt.stopping || this.shuttingDown) return
			if (online) this.queueReconnect(rt, code, Date.now() - t0)
			else this.enterOffline(rt, code)
		})
	}

	/** normal reconnect with exponential backoff. `spentMs` (time already used by the network check) is deducted from the delay. */
	private queueReconnect(rt: Runtime<S>, code?: number, spentMs = 0, immediateNow = false) {
		const r = this.reconnectOpts
		const immediate = immediateNow || code === ZX_CODE.restartRequired // restart after QR/pairing is normal, not an error
		if (!immediate) rt.attempts++
		if (rt.attempts > r.maxAttempts) {
			rt.status = 'stopped'
			this.log.error({ session: rt.id, attempts: rt.attempts - 1 }, 'zenox: giving up reconnecting')
			this.emit('give-up', { session: rt.id, attempts: rt.attempts - 1 })
			return
		}

		const delayMs = immediate ? 0 : Math.max(0, computeReconnectDelay(rt.attempts, r) - spentMs)
		rt.status = 'reconnecting'
		rt.activity?.record('reconnecting', { attempt: rt.attempts, delayMs, code })
		this.emit('reconnecting', { session: rt.id, attempt: rt.attempts, delayMs, code })
		if (rt.timer) clearTimeout(rt.timer)
		rt.timer = setTimeout(() => {
			rt.timer = undefined
			this.connect(rt).catch(err => {
				this.log.error({ session: rt.id, err }, 'zenox: reconnect failed')
				this.scheduleReconnect(rt, undefined)
			})
		}, delayMs)
	}

	/** No internet: stop retrying blindly (attempts are NOT counted), poll until it is back, then reconnect at once. */
	private enterOffline(rt: Runtime<S>, code?: number) {
		const monitor = this.network as NetworkMonitor
		if (rt.offlineSince === undefined) {
			rt.offlineSince = Date.now()
			rt.activity?.patch({ status: 'offline' })
			rt.activity?.record('offline', { code })
			this.log.warn({ session: rt.id, code }, 'zenox: no internet connection, waiting for it to come back')
			this.emit('offline', { session: rt.id, since: rt.offlineSince, code })
		}

		rt.status = 'offline'
		if (rt.timer) clearTimeout(rt.timer)
		rt.timer = setTimeout(() => {
			rt.timer = undefined
			if (rt.stopping || this.shuttingDown) return
			void monitor.check().then(online => {
				if (rt.stopping || this.shuttingDown) return
				if (!online) {
					this.enterOffline(rt, code)
					return
				}

				const offlineMs = Date.now() - (rt.offlineSince ?? Date.now())
				rt.offlineSince = undefined
				rt.attempts = 0
				rt.activity?.record('online', { offlineMs })
				this.log.info({ session: rt.id, offlineMs }, 'zenox: internet is back, reconnecting')
				this.emit('online', { session: rt.id, offlineMs })
				this.queueReconnect(rt, undefined, 0, true)
			})
		}, monitor.pollMs)
	}

	/* ---------------------------- process hooks ----------------------------- */

	private installHooks(h: ProcessHookOptions) {
		const timeoutMs = h.shutdownTimeoutMs ?? 8000
		const exitOnSignal = h.exitOnSignal ?? true
		const uncaughtPolicy = h.uncaughtException ?? 'exit'
		const rejectionPolicy = h.unhandledRejection ?? 'continue'
		const cleanups: Array<() => void> = []

		const hardExit = (code: number) => {
			const t = setTimeout(() => process.exit(code), timeoutMs)
			t.unref?.()
		}

		if (h.signals !== false) {
			const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
			if (process.platform === 'win32') signals.push('SIGBREAK')
			for (const sig of signals) {
				const handler = () => {
					hardExit(1)
					this.shutdown(sig)
						.catch(err => this.log.error({ err }, 'zenox: shutdown failed'))
						.finally(() => {
							if (exitOnSignal && process.listenerCount(sig) <= 1) {
								process.exit(128 + ((osConstants.signals as Record<string, number>)[sig] ?? 15))
							}
						})
				}

				process.on(sig, handler)
				cleanups.push(() => process.off(sig, handler))
			}
		}

		const onUncaught = (err: unknown) => {
			this.log.error({ err }, 'zenox: uncaught exception, saving sessions')
			this.flushAllSync()
			if (uncaughtPolicy === 'exit' && process.listenerCount('uncaughtException') <= 1) {
				hardExit(1)
				this.shutdown('uncaughtException').finally(() => process.exit(1))
			}
		}

		const onRejection = (err: unknown) => {
			this.log.error({ err }, 'zenox: unhandled rejection')
			this.flushAllSync()
			if (rejectionPolicy === 'exit' && process.listenerCount('unhandledRejection') <= 1) {
				hardExit(1)
				this.shutdown('unhandledRejection').finally(() => process.exit(1))
			}
		}

		const onBeforeExit = () => {
			if ([...this.runtimes.values()].some(r => (r.auth?.store.pendingCount ?? 0) > 0)) void this.flushAll()
		}

		const onExit = () => this.flushAllSync()

		process.on('uncaughtException', onUncaught)
		process.on('unhandledRejection', onRejection)
		process.on('beforeExit', onBeforeExit)
		process.on('exit', onExit)
		cleanups.push(
			() => process.off('uncaughtException', onUncaught),
			() => process.off('unhandledRejection', onRejection),
			() => process.off('beforeExit', onBeforeExit),
			() => process.off('exit', onExit)
		)
		this.removeHooks = () => {
			for (const c of cleanups.splice(0)) c()
			this.removeHooks = undefined
		}
	}
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
