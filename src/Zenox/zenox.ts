import { basename, dirname, resolve } from 'path'
import { proto } from '../../WAProto/index.js'
import makeWASocket from '../Socket/index'
import type { UserFacingSocketConfig } from '../Types'
import { initAuthCreds } from '../Utils/auth-utils'
import { fetchLatestBaileysVersion } from '../Utils/generics'
import { generateWAMessageFromContent } from '../Utils/messages'
import { createZenoxAuthState, type ZenoxAuthHandle } from './auth-state'
import { MemoryCache, RedisCache, TieredCache } from './cache'
import { ZenoxManager, type ProcessHookOptions, type ReconnectOptions, type SentStore, type ZenoxManagerOptions } from './manager'
import type { NetworkOptions } from './network'
import { adaptRedis, connectRedis } from './redis'
import { ZenoxRich, type RichOptions, type RichSocketLike } from './rich/rich'
import { FileStorage, MirrorStorage, RedisStorage } from './storage'
import { defaultLogger, type ZenoxLogger, type ZenoxStorage } from './types'
import type { WriteBehindOptions } from './write-behind'

/** A Baileys socket plus `sock.rich`: markdown, code, tables, math, buttons and "Lihat selengkapnya". */
export type ZenoxSocket = ReturnType<typeof makeWASocket> & { rich: ZenoxRich }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reviveKey = (type: string, value: any) =>
	type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value

/**
 * Sent messages are stored as protobuf bytes: compact, and Long/Buffer fields come back exactly as Baileys expects.
 * `set` is fire-and-forget (memory is updated now, redis a moment later); `get` falls back to redis after a restart.
 */
const createSentStore = (cache: TieredCache): SentStore => ({
	set: (id, message) => {
		cache.set(id, Buffer.from(proto.Message.encode(message).finish()))
	},
	get: async id => {
		const raw = await cache.get<Buffer>(id)
		return raw ? proto.Message.decode(raw) : undefined
	}
})

export interface ZenoxOptions extends WriteBehindOptions {
	/** where sessions are stored on disk (default `./zenox-sessions`) */
	sessionDir?: string
	/** a `redis://` / `rediss://` URL (needs `npm i ioredis`) or an existing ioredis / node-redis client */
	redis?: string | object
	/** prefix of every redis key (default `zenox`) */
	redisPrefix?: string
	/**
	 * `file`: disk only. `redis`: redis only (no disk needed). `redis+file`: disk is used for reads/crash safety
	 * and redis keeps a replica that restores the session on a fresh/wiped disk.
	 * Default: `redis+file` when `redis` is set, otherwise `file`.
	 */
	sessionStore?: 'file' | 'redis' | 'redis+file'
	/** bring your own storage backend (overrides sessionDir / redis for sessions) */
	storage?: ZenoxStorage
	/** Baileys config applied to every session */
	socketConfig?: Partial<UserFacingSocketConfig> | ((session: string) => Partial<UserFacingSocketConfig>)
	/** look up the newest WhatsApp Web version once at startup (recommended if you see 405 errors) */
	fetchLatestVersion?: boolean
	reconnect?: ReconnectOptions
	/** detect "no internet" and wait for it instead of retrying blindly (default on, `false` to disable) */
	network?: NetworkOptions | false
	/** save-on-exit hooks, `false` to install none */
	hooks?: boolean | ProcessHookOptions
	logger?: ZenoxLogger
	/** group metadata cache lifetime (default 5 min). Updates from WhatsApp invalidate it immediately. */
	groupMetadataTtlMs?: number
	/** wrap `sock.groupMetadata()` with the cache (default true) */
	cacheGroupMetadata?: boolean
	/** also keep caches in redis (default true when redis is configured) */
	redisCache?: boolean
	sentMessageCache?: number
	/** how long sent messages stay available for retries, in memory and in redis (default 1 hour) */
	sentMessageTtlMs?: number
	/** reuse uploads of the same media `{ url }` instead of encrypting + uploading again (default on) */
	cacheMedia?: boolean
	/** max media entries kept per session (default 300) */
	mediaCacheSize?: number
	/** how long a media upload is reused (default 1 hour) */
	mediaCacheTtlMs?: number
	staggerMs?: number
	/** rich messages (`sock.rich`): options, or `false` to switch the feature off. Default on, mode 'text'. */
	rich?: RichOptions | false
}

/**
 * Create a manager for one or many WhatsApp sessions.
 *
 * ```ts
 * const zenox = await createZenox({ redis: process.env.REDIS_URL })
 * zenox.onSocket(sock => sock.ev.on('messages.upsert', handle)) // runs again after every reconnect
 * await zenox.start('main', { pairingPhone: '62812xxxx' })
 * ```
 */
export async function createZenox(options: ZenoxOptions = {}): Promise<ZenoxManager<ZenoxSocket>> {
	const logger = options.logger ?? defaultLogger
	const prefix = options.redisPrefix ?? 'zenox'
	const createdClient = typeof options.redis === 'string'
	const client = options.redis ? (createdClient ? await connectRedis(options.redis as string) : options.redis) : undefined
	if (client && createdClient && typeof client.on === 'function') {
		client.on('error', (err: unknown) => logger.warn({ err }, 'zenox: redis error'))
	}

	const file = new FileStorage(options.sessionDir ?? './zenox-sessions')
	const mode = options.sessionStore ?? (client ? 'redis+file' : 'file')
	if (mode !== 'file' && !client && !options.storage) throw new Error(`zenox: sessionStore "${mode}" needs the \`redis\` option`)

	const redisStorage = client ? new RedisStorage(client, { prefix }) : undefined
	const storage: ZenoxStorage =
		options.storage ??
		(mode === 'file'
			? file
			: mode === 'redis'
				? (redisStorage as RedisStorage)
				: new MirrorStorage(file, redisStorage as RedisStorage, { logger }))

	const redisForCache = client && options.redisCache !== false ? adaptRedis(client) : undefined
	const groupTtl = options.groupMetadataTtlMs ?? 5 * 60_000
	const sentTtl = options.sentMessageTtlMs ?? 60 * 60_000
	const l2 = (session: string, name: string, ttlMs: number) =>
		redisForCache
			? new RedisCache(redisForCache, {
					prefix: `${prefix}:cache:${session}:${name}`,
					ttlSeconds: Math.max(1, Math.round(ttlMs / 1000)),
					logger
				})
			: undefined

	let socketConfig = options.socketConfig
	if (options.fetchLatestVersion) {
		const { version } = await fetchLatestBaileysVersion()
		const base = socketConfig
		socketConfig = (session: string) => ({ version, ...(typeof base === 'function' ? base(session) : (base ?? {})) })
	}

	const manager = new ZenoxManager<ZenoxSocket>({
		makeSocket: config => makeWASocket(config as UserFacingSocketConfig) as ZenoxSocket,
		storage,
		logger,
		reconnect: options.reconnect,
		network: options.network,
		hooks: options.hooks,
		sentMessageCache: options.sentMessageCache,
		cacheGroupMetadata: options.cacheGroupMetadata,
		staggerMs: options.staggerMs,
		socketConfig: socketConfig as ZenoxManagerOptions<ZenoxSocket>['socketConfig'],
		createAuth: session =>
			createZenoxAuthState(storage, session, {
				initCreds: initAuthCreds,
				reviveKey,
				flushIntervalMs: options.flushIntervalMs,
				maxPending: options.maxPending,
				cacheSize: options.cacheSize,
				writeThrough: options.writeThrough,
				logger
			}),
		createCaches: session => ({
			groups: new TieredCache(new MemoryCache({ max: 2000, ttlMs: groupTtl }), l2(session, 'groups', groupTtl), groupTtl),
			userDevicesCache: new TieredCache(
				new MemoryCache({ max: 20_000, ttlMs: 5 * 60_000 }),
				l2(session, 'devices', 5 * 60_000),
				5 * 60_000
			),
			// media uploads are only reused in memory: WhatsApp media links expire, so a restart should start clean
			...(options.cacheMedia === false
				? {}
				: {
						mediaCache: new MemoryCache({
							max: options.mediaCacheSize ?? 300,
							ttlMs: options.mediaCacheTtlMs ?? 60 * 60_000
						})
					}),
			sent: createSentStore(
				new TieredCache(
					new MemoryCache({ max: options.sentMessageCache || 500, ttlMs: sentTtl }),
					l2(session, 'sent', sentTtl),
					sentTtl
				)
			),
			// retry counters must survive reconnects but not restarts: memory is enough
			msgRetryCounterCache: new MemoryCache({ ttlMs: 60 * 60_000 }),
			callOfferCache: new MemoryCache({ ttlMs: 5 * 60_000 }),
			placeholderResendCache: new MemoryCache({ ttlMs: 60 * 60_000 })
		})
	})

	if (options.rich !== false) {
		// one ZenoxRich per session, kept across reconnects: its handlers and "see more" state survive a new socket
		const richBySession = new Map<string, ZenoxRich>()
		const richTtl = options.rich?.stateTtlMs ?? 24 * 60 * 60_000
		manager.onSocket((sock, { session }) => {
			let rich = richBySession.get(session)
			if (!rich) {
				rich = new ZenoxRich({
					buildMessage: generateWAMessageFromContent as never,
					store: new TieredCache(new MemoryCache({ max: 5000, ttlMs: richTtl }), l2(session, 'rich', richTtl), richTtl),
					options: options.rich || undefined,
					logger
				})
				richBySession.set(session, rich)
			}

			sock.rich = rich.attach(sock as unknown as RichSocketLike)
		})
		manager.on('logged-out', ({ session }) => void richBySession.delete(session))
	}

	if (createdClient) {
		manager.once('shutdown', () => {
			const q = client as { quit?: () => Promise<unknown> }
			void q.quit?.().catch(() => {})
		})
	}

	return manager
}

/* -------------------------------------------------------------------------- */
/* Standalone auth helpers (use these without the manager)                    */
/* -------------------------------------------------------------------------- */

export interface UseZenoxAuthOptions extends WriteBehindOptions {
	/** folder that contains the session folders (default `./zenox-sessions`) */
	sessionDir?: string
	/** a redis client to replicate the session to (optional) */
	redis?: object
	redisPrefix?: string
	storage?: ZenoxStorage
}

/**
 * Same shape as `useMultiFileAuthState`, faster and with optional redis replication:
 * `const { state, saveCreds } = await useZenoxAuthState('main')`
 * Remember to `await auth.flush()` (or `close()`) before you exit your process.
 */
export async function useZenoxAuthState(
	session: string,
	options: UseZenoxAuthOptions = {}
): Promise<ZenoxAuthHandle> {
	const file = new FileStorage(options.sessionDir ?? './zenox-sessions')
	const storage =
		options.storage ??
		(options.redis
			? new MirrorStorage(file, new RedisStorage(options.redis, { prefix: options.redisPrefix ?? 'zenox' }), {
					logger: options.logger
				})
			: file)
	return createZenoxAuthState(storage, session, { ...options, initCreds: initAuthCreds, reviveKey })
}

/**
 * Migration helper: opens an EXISTING `useMultiFileAuthState('some_folder')` folder as-is.
 * `const { state, saveCreds } = await useZenoxFileAuthState('baileys_auth_info')`
 */
export async function useZenoxFileAuthState(folder: string, options: WriteBehindOptions = {}): Promise<ZenoxAuthHandle> {
	const abs = resolve(folder)
	return createZenoxAuthState(new FileStorage(dirname(abs)), basename(abs), { ...options, initCreds: initAuthCreds, reviveKey })
}
