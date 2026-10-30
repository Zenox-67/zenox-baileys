import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { adaptRedis, escapeGlob, type RedisOp, type ZenoxRedis } from './redis'
import {
	assertSessionId,
	SESSION_ID_RE,
	silentLogger,
	type StorageEntry,
	type ZenoxLogger,
	type ZenoxStorage
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isENOENT = (e: any) => e?.code === 'ENOENT'

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		t.unref?.()
		promise.then(
			v => {
				clearTimeout(t)
				resolve(v)
			},
			e => {
				clearTimeout(t)
				reject(e)
			}
		)
	})

const runPool = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
	let next = 0
	let firstError: unknown
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++] as T
			try {
				await fn(item)
			} catch (e) {
				firstError ??= e
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	if (firstError !== undefined) throw firstError
}

/* -------------------------------------------------------------------------- */
/* File storage                                                               */
/* -------------------------------------------------------------------------- */

let tmpCounter = 0
const tmpName = (path: string) => `${path}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`
const fixFileName = (key: string) => key.replace(/[\\/]/g, '__').replace(/:/g, '-').replace(/\0/g, '')

/**
 * One folder per session, one JSON file per key. File names are the same as
 * `useMultiFileAuthState`, so existing `baileys_auth_info` folders keep working.
 * Writes are atomic (temp file + rename), a crash can never leave a half-written file.
 */
export class FileStorage implements ZenoxStorage {
	readonly name = 'file'

	constructor(
		private readonly dir: string,
		private readonly concurrency = 16
	) {}

	private folder(session: string) {
		return join(this.dir, assertSessionId(session))
	}

	private path(session: string, key: string) {
		const file = fixFileName(key)
		if (!file) throw new Error(`invalid storage key: "${key}"`)
		return join(this.folder(session), `${file}.json`)
	}

	async read(session: string, key: string): Promise<string | null> {
		try {
			return await readFile(this.path(session, key), 'utf-8')
		} catch (e) {
			if (isENOENT(e)) return null
			throw e
		}
	}

	async write(session: string, entries: StorageEntry[]): Promise<void> {
		if (!entries.length) return
		await mkdir(this.folder(session), { recursive: true })
		await runPool(entries, this.concurrency, async ([key, value]) => {
			const path = this.path(session, key)
			if (value === null) {
				await unlink(path).catch(e => {
					if (!isENOENT(e)) throw e
				})
				return
			}

			const tmp = tmpName(path)
			try {
				await writeFile(tmp, value)
				await rename(tmp, path)
			} catch (e) {
				await unlink(tmp).catch(() => {})
				throw e
			}
		})
	}

	writeSync(session: string, entries: StorageEntry[]): void {
		if (!entries.length) return
		mkdirSync(this.folder(session), { recursive: true })
		for (const [key, value] of entries) {
			const path = this.path(session, key)
			if (value === null) {
				try {
					unlinkSync(path)
				} catch (e) {
					if (!isENOENT(e)) throw e
				}

				continue
			}

			const tmp = tmpName(path)
			writeFileSync(tmp, value)
			renameSync(tmp, path)
		}
	}

	async sessions(): Promise<string[]> {
		try {
			const items = await readdir(this.dir, { withFileTypes: true })
			return items.filter(i => i.isDirectory() && SESSION_ID_RE.test(i.name)).map(i => i.name)
		} catch (e) {
			if (isENOENT(e)) return []
			throw e
		}
	}

	async removeSession(session: string): Promise<void> {
		await rm(this.folder(session), { recursive: true, force: true })
	}
}

/* -------------------------------------------------------------------------- */
/* Memory storage (tests / throwaway sessions)                                */
/* -------------------------------------------------------------------------- */

export class MemoryStorage implements ZenoxStorage {
	readonly name = 'memory'
	readonly data = new Map<string, Map<string, string>>()

	async read(session: string, key: string) {
		return this.data.get(assertSessionId(session))?.get(key) ?? null
	}

	async write(session: string, entries: StorageEntry[]) {
		this.writeSync(session, entries)
	}

	writeSync(session: string, entries: StorageEntry[]) {
		let m = this.data.get(assertSessionId(session))
		if (!m) this.data.set(session, (m = new Map()))
		for (const [k, v] of entries) v === null ? m.delete(k) : m.set(k, v)
	}

	async listKeys(session: string) {
		return [...(this.data.get(assertSessionId(session))?.keys() ?? [])]
	}

	async sessions() {
		return [...this.data.keys()]
	}

	async removeSession(session: string) {
		this.data.delete(assertSessionId(session))
	}
}

/* -------------------------------------------------------------------------- */
/* Redis storage                                                              */
/* -------------------------------------------------------------------------- */

export interface RedisStorageOptions {
	/** quit() the redis client when the storage is closed (default false: the client is yours) */
	ownsClient?: boolean
	prefix?: string
	/** optional expiry for session keys. Leave unset for permanent sessions. */
	ttlSeconds?: number
}

/**
 * Sessions in Redis: `<prefix>:<session>:k:<key>` strings plus a `<prefix>:sessions` set.
 * Reads of many keys use a single MGET, writes use a single pipeline.
 */
export class RedisStorage implements ZenoxStorage {
	readonly name = 'redis'
	private readonly redis: ZenoxRedis
	private readonly prefix: string
	private readonly ttl?: number
	private readonly owns: boolean
	private readonly known = new Set<string>()

	constructor(client: unknown, opts: RedisStorageOptions = {}) {
		this.redis = adaptRedis(client)
		this.owns = opts.ownsClient ?? false
		this.prefix = opts.prefix ?? 'zenox'
		this.ttl = opts.ttlSeconds
	}

	private k(session: string, key: string) {
		return `${this.prefix}:${assertSessionId(session)}:k:${key}`
	}

	private get sessionsKey() {
		return `${this.prefix}:sessions`
	}

	read(session: string, key: string) {
		return this.redis.get(this.k(session, key))
	}

	readMany(session: string, keys: string[]) {
		return this.redis.mget(keys.map(key => this.k(session, key)))
	}

	async write(session: string, entries: StorageEntry[]) {
		if (!entries.length) return
		const ops: RedisOp[] = []
		let hasSet = false
		for (const [key, value] of entries) {
			if (value === null) ops.push(['del', this.k(session, key)])
			else {
				hasSet = true
				ops.push(['set', this.k(session, key), value, this.ttl])
			}
		}

		if (hasSet && !this.known.has(session)) ops.push(['sadd', this.sessionsKey, session])
		await this.redis.exec(ops)
		if (hasSet) this.known.add(session)
	}

	async listKeys(session: string) {
		const base = this.k(session, '')
		const keys = await this.redis.scanKeys(`${escapeGlob(base)}*`)
		return keys.map(k => k.slice(base.length))
	}

	async sessions() {
		return this.redis.smembers(this.sessionsKey)
	}

	async removeSession(session: string) {
		await this.redis.scanDelete(`${escapeGlob(this.k(session, ''))}*`)
		await this.redis.exec([['srem', this.sessionsKey, session]])
		this.known.delete(session)
	}

	async close() {
		if (this.owns) await this.redis.quit().catch(() => {})
	}
}

/* -------------------------------------------------------------------------- */
/* Mirror: local (fast, crash safe) + remote (backup / restore)               */
/* -------------------------------------------------------------------------- */

/**
 * Reads ALWAYS come from `local` (no network round-trip), writes go to `local` first
 * and are then replicated to `remote`. If `local` has no session yet (fresh container,
 * wiped disk, new host) the session is restored from `remote` the first time it is used.
 *
 * A failing/slow remote never fails or blocks a write: the entries are kept in an
 * in-memory backlog and replayed with the next write.
 */
export class MirrorStorage implements ZenoxStorage {
	readonly name: string
	private readonly ready = new Map<string, Promise<void>>()
	private readonly backlog = new Map<string, Map<string, string | null>>()

	constructor(
		private readonly local: ZenoxStorage,
		private readonly remote: ZenoxStorage,
		private readonly opts: { logger?: ZenoxLogger; remoteTimeoutMs?: number } = {}
	) {
		this.name = `mirror(${local.name}+${remote.name})`
	}

	private get log() {
		return this.opts.logger ?? silentLogger
	}

	private hydrate(session: string): Promise<void> {
		let p = this.ready.get(session)
		if (!p) this.ready.set(session, (p = this.restoreIfEmpty(session)))
		return p
	}

	private async restoreIfEmpty(session: string) {
		if ((await this.local.read(session, 'creds')) !== null) return
		if (!this.remote.listKeys) return
		try {
			const keys = await withTimeout(this.remote.listKeys(session), this.opts.remoteTimeoutMs ?? 8000, 'remote listKeys')
			if (!keys.includes('creds')) return
			const values = this.remote.readMany
				? await this.remote.readMany(session, keys)
				: await Promise.all(keys.map(k => this.remote.read(session, k)))
			const entries: StorageEntry[] = []
			keys.forEach((k, i) => {
				const v = values[i]
				if (typeof v === 'string') entries.push([k, v])
			})
			await this.local.write(session, entries)
			this.log.info({ session, keys: entries.length }, 'zenox: session restored from remote storage')
		} catch (err) {
			this.log.warn({ session, err }, 'zenox: could not restore session from remote storage')
		}
	}

	async read(session: string, key: string) {
		await this.hydrate(session)
		return this.local.read(session, key)
	}

	async readMany(session: string, keys: string[]) {
		await this.hydrate(session)
		return this.local.readMany ? this.local.readMany(session, keys) : Promise.all(keys.map(k => this.local.read(session, k)))
	}

	async write(session: string, entries: StorageEntry[]) {
		await this.hydrate(session)
		await this.local.write(session, entries)
		await this.replicate(session, entries)
	}

	private async replicate(session: string, entries: StorageEntry[]) {
		const pending = this.backlog.get(session) ?? new Map<string, string | null>()
		for (const [k, v] of entries) pending.set(k, v)
		try {
			await withTimeout(
				this.remote.write(session, [...pending]),
				this.opts.remoteTimeoutMs ?? 3000,
				`remote write (${this.remote.name})`
			)
			this.backlog.delete(session)
		} catch (err) {
			this.backlog.set(session, pending)
			this.log.warn({ session, queued: pending.size, err }, 'zenox: remote write failed, kept in backlog')
		}
	}

	/** number of entries waiting to be replicated to the remote backend */
	get backlogSize() {
		let n = 0
		for (const m of this.backlog.values()) n += m.size
		return n
	}

	writeSync(session: string, entries: StorageEntry[]) {
		if (!this.local.writeSync) throw new Error('local storage has no writeSync')
		this.local.writeSync(session, entries)
		const pending = this.backlog.get(session) ?? new Map<string, string | null>()
		for (const [k, v] of entries) pending.set(k, v)
		this.backlog.set(session, pending)
	}

	async sessions() {
		const [a, b] = await Promise.all([
			this.local.sessions(),
			this.remote.sessions().catch(() => [] as string[])
		])
		return [...new Set([...a, ...b])]
	}

	async removeSession(session: string) {
		this.backlog.delete(session)
		this.ready.delete(session)
		await this.local.removeSession(session)
		await this.remote.removeSession(session).catch(err => this.log.warn({ session, err }, 'zenox: remote removeSession failed'))
	}

	async close() {
		await this.remote.close?.().catch(() => {})
		await this.local.close?.().catch(() => {})
	}
}
