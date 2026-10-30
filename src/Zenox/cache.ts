import type { CacheStore } from '../Types'
import type { ZenoxRedis } from './redis'
import { zxParse, zxStringify } from './serializer'
import { silentLogger, type ZenoxLogger } from './types'

/** In-memory LRU with per-entry TTL. Implements Baileys' `CacheStore`. */
export class MemoryCache implements CacheStore {
	private readonly map = new Map<string, { v: unknown; exp: number }>()
	private readonly max: number
	private readonly ttlMs: number

	constructor(opts: { max?: number; ttlMs?: number } = {}) {
		this.max = opts.max ?? 10_000
		this.ttlMs = opts.ttlMs ?? 5 * 60_000
	}

	get size() {
		return this.map.size
	}

	get<T>(key: string): T | undefined {
		const e = this.map.get(key)
		if (!e) return undefined
		if (e.exp && e.exp <= Date.now()) {
			this.map.delete(key)
			return undefined
		}

		this.map.delete(key)
		this.map.set(key, e) // LRU touch
		return e.v as T
	}

	set<T>(key: string, value: T, ttlMs = this.ttlMs): boolean {
		this.map.delete(key)
		this.map.set(key, { v: value, exp: ttlMs > 0 ? Date.now() + ttlMs : 0 })
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next()
			if (oldest.done) break
			this.map.delete(oldest.value)
		}

		return true
	}

	del(key: string): boolean {
		return this.map.delete(key)
	}

	flushAll(): void {
		this.map.clear()
	}

	close(): void {
		this.map.clear()
	}
}

export interface RedisCacheOptions {
	prefix?: string
	ttlSeconds?: number
	logger?: ZenoxLogger
	/** after a redis failure, skip redis for this long instead of making every call wait (default 10s) */
	cooldownMs?: number
}

/**
 * Redis-backed cache. It NEVER throws: if Redis is slow or down it behaves like a miss,
 * and a small circuit breaker stops it from adding latency to every call.
 */
export class RedisCache {
	private downUntil = 0
	private readonly prefix: string
	private readonly ttl: number
	private readonly cooldown: number
	private readonly log: ZenoxLogger

	constructor(
		private readonly redis: ZenoxRedis,
		opts: RedisCacheOptions = {}
	) {
		this.prefix = opts.prefix ?? 'zenox:cache'
		this.ttl = opts.ttlSeconds ?? 300
		this.cooldown = opts.cooldownMs ?? 10_000
		this.log = opts.logger ?? silentLogger
	}

	private fail(err: unknown) {
		this.downUntil = Date.now() + this.cooldown
		this.log.warn({ err }, 'zenox: redis cache unavailable, falling back to memory only')
	}

	private get down() {
		return Date.now() < this.downUntil
	}

	async get<T>(key: string): Promise<T | undefined> {
		if (this.down) return undefined
		try {
			const raw = await this.redis.get(`${this.prefix}:${key}`)
			return raw === null ? undefined : zxParse<T>(raw)
		} catch (err) {
			this.fail(err)
			return undefined
		}
	}

	async set<T>(key: string, value: T, ttlSeconds = this.ttl): Promise<boolean> {
		if (this.down) return false
		try {
			await this.redis.exec([['set', `${this.prefix}:${key}`, zxStringify(value), ttlSeconds > 0 ? ttlSeconds : undefined]])
			return true
		} catch (err) {
			this.fail(err)
			return false
		}
	}

	async del(key: string): Promise<boolean> {
		if (this.down) return false
		try {
			await this.redis.exec([['del', `${this.prefix}:${key}`]])
			return true
		} catch (err) {
			this.fail(err)
			return false
		}
	}

	async flushAll(): Promise<void> {
		if (this.down) return
		try {
			await this.redis.scanDelete(`${this.prefix.replace(/[\\*?[\]]/g, '\\$&')}:*`)
		} catch (err) {
			this.fail(err)
		}
	}
}

/**
 * L1 memory + optional L2 redis. Hits in memory return synchronously (no await, no network).
 * Also gives you `wrap()` so the same expensive call is never run twice at the same time.
 * Implements Baileys' `CacheStore`, so it can be passed as `msgRetryCounterCache`, `userDevicesCache`, ...
 */
export class TieredCache implements CacheStore {
	private readonly inflight = new Map<string, Promise<unknown>>()

	constructor(
		private readonly l1: MemoryCache = new MemoryCache(),
		private readonly l2?: RedisCache,
		private readonly ttlMs = 5 * 60_000
	) {}

	get<T>(key: string): Promise<T> | T | undefined {
		const hit = this.l1.get<T>(key)
		if (hit !== undefined || !this.l2) return hit
		return this.fromL2<T>(key)
	}

	private async fromL2<T>(key: string): Promise<T> {
		const v = await this.l2!.get<T>(key)
		if (v !== undefined) this.l1.set(key, v, this.ttlMs)
		return v as T // `undefined` on a miss, matching CacheStore semantics
	}

	set<T>(key: string, value: T, ttlMs = this.ttlMs): boolean {
		this.l1.set(key, value, ttlMs)
		if (this.l2) void this.l2.set(key, value, Math.max(1, Math.round(ttlMs / 1000)))
		return true
	}

	del(key: string): boolean {
		const had = this.l1.del(key)
		if (this.l2) void this.l2.del(key)
		return had
	}

	flushAll(): void {
		this.l1.flushAll()
		if (this.l2) void this.l2.flushAll()
	}

	close(): void {
		this.l1.close()
	}

	/** get-or-compute. Concurrent calls for the same key share ONE `fn()` execution. */
	async wrap<T>(key: string, fn: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
		const cached = await this.get<T>(key)
		if (cached !== undefined) return cached
		const running = this.inflight.get(key) as Promise<T> | undefined
		if (running) return running
		const p = (async () => {
			try {
				const value = await fn()
				if (value !== undefined) this.set(key, value, ttlMs)
				return value
			} finally {
				this.inflight.delete(key)
			}
		})()
		this.inflight.set(key, p)
		return p
	}
}
