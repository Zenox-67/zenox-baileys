import { zxParse, zxStringify } from './serializer'
import { silentLogger, type StorageEntry, type ZenoxLogger, type ZenoxStorage } from './types'

export interface WriteBehindOptions {
	/** how long writes are collected before one batched flush (default 1000ms) */
	flushIntervalMs?: number
	/** flush immediately once this many keys are waiting (default 300) */
	maxPending?: number
	/** max parsed keys kept in memory for fast reads (default 20000) */
	cacheSize?: number
	/** disable write-behind: every write is flushed immediately (slower, safest) */
	writeThrough?: boolean
	logger?: ZenoxLogger
}

interface Pending {
	str: string | null
	val: unknown
}

/**
 * Per-session key/value layer in front of a {@link ZenoxStorage}:
 *  - reads are served from memory (pending writes first, then an LRU of parsed values)
 *  - writes only touch memory, then are flushed to storage in ONE batch
 *  - `flushSync()` lets the process save everything even while it is already exiting
 */
export class WriteBehindStore {
	private pending = new Map<string, Pending>()
	private readonly cache = new Map<string, unknown>()
	private timer?: ReturnType<typeof setTimeout>
	private chain: Promise<void> = Promise.resolve()
	private closed = false
	/** consecutive failed flushes; while > 0 retries use a growing delay instead of hammering a broken storage */
	private failures = 0
	lastError?: unknown

	private readonly flushIntervalMs: number
	private readonly maxPending: number
	private readonly cacheSize: number
	private readonly writeThrough: boolean
	private readonly log: ZenoxLogger

	constructor(
		readonly storage: ZenoxStorage,
		readonly session: string,
		opts: WriteBehindOptions = {}
	) {
		this.flushIntervalMs = opts.flushIntervalMs ?? 1000
		this.maxPending = opts.maxPending ?? 300
		this.cacheSize = opts.cacheSize ?? 20_000
		this.writeThrough = opts.writeThrough ?? false
		this.log = opts.logger ?? silentLogger
	}

	get pendingCount() {
		return this.pending.size
	}

	private remember(key: string, val: unknown) {
		this.cache.delete(key)
		this.cache.set(key, val)
		while (this.cache.size > this.cacheSize) {
			const oldest = this.cache.keys().next()
			if (oldest.done) break
			this.cache.delete(oldest.value)
		}
	}

	private fromMemory<T>(key: string): { hit: true; value: T | null } | { hit: false } {
		const p = this.pending.get(key)
		if (p) return { hit: true, value: p.str === null ? null : (p.val as T) }
		if (this.cache.has(key)) {
			const v = this.cache.get(key)
			this.cache.delete(key)
			this.cache.set(key, v) // LRU touch
			return { hit: true, value: v as T }
		}

		return { hit: false }
	}

	private parse<T>(key: string, raw: string): T | null {
		try {
			return zxParse<T>(raw)
		} catch (err) {
			this.log.warn({ session: this.session, key, err }, 'zenox: corrupt value ignored')
			return null
		}
	}

	async get<T>(key: string): Promise<T | null> {
		const mem = this.fromMemory<T>(key)
		if (mem.hit) return mem.value
		const raw = await this.storage.read(this.session, key)
		const again = this.fromMemory<T>(key) // a write may have landed while we were reading
		if (again.hit) return again.value
		if (raw === null) return null
		const val = this.parse<T>(key, raw)
		if (val !== null) this.remember(key, val)
		return val
	}

	async getMany<T>(keys: string[]): Promise<Array<T | null>> {
		const out: Array<T | null> = new Array(keys.length).fill(null)
		const missIdx: number[] = []
		keys.forEach((key, i) => {
			const mem = this.fromMemory<T>(key)
			if (mem.hit) out[i] = mem.value
			else missIdx.push(i)
		})
		if (!missIdx.length) return out

		const missKeys = missIdx.map(i => keys[i] as string)
		const raws = this.storage.readMany
			? await this.storage.readMany(this.session, missKeys)
			: await Promise.all(missKeys.map(k => this.storage.read(this.session, k)))

		missIdx.forEach((idx, j) => {
			const key = keys[idx] as string
			const again = this.fromMemory<T>(key)
			if (again.hit) {
				out[idx] = again.value
				return
			}

			const raw = raws[j]
			if (typeof raw !== 'string') return
			const val = this.parse<T>(key, raw)
			if (val !== null) {
				this.remember(key, val)
				out[idx] = val
			}
		})
		return out
	}

	/** Synchronous from the caller's view: memory is updated now, disk/redis a moment later. `null` deletes. */
	set(key: string, value: unknown): void {
		if (this.closed) {
			this.log.warn({ session: this.session, key }, 'zenox: write ignored, store is closed')
			return
		}

		if (value === null || value === undefined) {
			this.cache.delete(key)
			this.pending.set(key, { str: null, val: null })
		} else {
			// serialise NOW so later in-place mutations of `value` cannot change what gets saved
			this.pending.set(key, { str: zxStringify(value), val: value })
			this.remember(key, value)
		}

		this.schedule()
	}

	private schedule() {
		// a broken storage must never be retried in a tight loop (that would freeze the whole process):
		// while flushes are failing, only the backoff timer below may trigger the next attempt
		if (!this.failures && (this.writeThrough || this.pending.size >= this.maxPending)) {
			this.flush().catch(() => {}) // errors are logged + re-queued inside flush
			return
		}

		if (this.timer) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			this.flush().catch(() => {})
		}, this.failures ? this.retryDelayMs() : this.flushIntervalMs)
		this.timer.unref?.()
	}

	/** flushIntervalMs, doubled after every consecutive failure, capped at 15s (never below 10ms) */
	private retryDelayMs() {
		const base = Math.max(this.flushIntervalMs, 10)
		return Math.min(base * 2 ** Math.max(0, this.failures - 1), Math.max(base, 15_000))
	}

	private requeue(batch: Map<string, Pending>) {
		for (const [k, p] of batch) if (!this.pending.has(k)) this.pending.set(k, p)
	}

	/** Write everything that is waiting. Concurrent calls are queued, never interleaved. */
	flush(): Promise<void> {
		const run = async () => {
			if (!this.pending.size) return
			const batch = this.pending
			this.pending = new Map()
			const entries: StorageEntry[] = [...batch].map(([k, p]) => [k, p.str])
			try {
				await this.storage.write(this.session, entries)
				this.lastError = undefined
				this.failures = 0
			} catch (err) {
				this.lastError = err
				this.failures++
				this.requeue(batch)
				this.log.error({ session: this.session, err, waiting: this.pending.size }, 'zenox: flush failed, will retry')
				if (!this.closed) this.schedule()
				throw err
			}
		}

		const next = this.chain.then(run)
		this.chain = next.catch(() => {})
		return next
	}

	/** Best-effort blocking save for `process.on('exit')`. Returns false if nothing could be written. */
	flushSync(): boolean {
		if (!this.pending.size) return true
		if (!this.storage.writeSync) return false
		const batch = this.pending
		this.pending = new Map()
		try {
			this.storage.writeSync(this.session, [...batch].map(([k, p]) => [k, p.str] as StorageEntry))
			return true
		} catch (err) {
			this.requeue(batch)
			this.log.error({ session: this.session, err }, 'zenox: sync flush failed')
			return false
		}
	}

	/** Flush and stop accepting writes. Never throws, so shutdown can always continue. */
	async close(): Promise<void> {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		try {
			await this.flush()
		} catch {
			// already logged
		}

		this.closed = true
	}

	/** Forget everything, including what is persisted (used on logout / remove). */
	async clear(): Promise<void> {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		this.closed = true
		this.pending.clear()
		this.cache.clear()
		await this.chain
		await this.storage.removeSession(this.session)
	}
}
