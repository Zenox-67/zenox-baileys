/**
 * Thin adapter so Zenox works with both `ioredis` and `redis` (node-redis v4+)
 * without importing either. You pass your own client; nothing is bundled.
 * Every write goes through ONE pipelined round-trip, which matters on hosted Redis (e.g. Upstash).
 */

export type RedisOp =
	| ['set', key: string, value: string, ttlSeconds?: number]
	| ['del', key: string]
	| ['sadd', key: string, member: string]
	| ['srem', key: string, member: string]

export interface ZenoxRedis {
	get(key: string): Promise<string | null>
	mget(keys: string[]): Promise<Array<string | null>>
	/** run all ops in one pipeline/transaction round-trip */
	exec(ops: RedisOp[]): Promise<void>
	smembers(key: string): Promise<string[]>
	/** all keys matching a glob pattern (cursor based, never uses KEYS) */
	scanKeys(pattern: string): Promise<string[]>
	/** delete every key matching a glob pattern, returns how many */
	scanDelete(pattern: string): Promise<number>
	quit(): Promise<void>
}

export const escapeGlob = (value: string) => value.replace(/[\\*?[\]]/g, '\\$&')

const isZenoxRedis = (c: any): c is ZenoxRedis =>
	typeof c?.exec === 'function' && typeof c?.scanDelete === 'function' && typeof c?.scanKeys === 'function'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function adaptRedis(client: any): ZenoxRedis {
	if (!client) throw new Error('zenox: redis client is required')
	if (isZenoxRedis(client)) return client

	// ---- ioredis ----------------------------------------------------------
	if (typeof client.pipeline === 'function') {
		const scanKeys = async (pattern: string) => {
			const found: string[] = []
			let cursor = '0'
			do {
				const [next, keys] = (await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500)) as [string, string[]]
				cursor = next
				found.push(...keys)
			} while (cursor !== '0')

			return [...new Set(found)]
		}

		return {
			get: key => client.get(key),
			mget: async keys => (keys.length ? client.mget(...keys) : []),
			exec: async ops => {
				if (!ops.length) return
				const p = client.pipeline()
				for (const op of ops) {
					if (op[0] === 'set') op[3] ? p.set(op[1], op[2], 'EX', op[3]) : p.set(op[1], op[2])
					else if (op[0] === 'del') p.del(op[1])
					else if (op[0] === 'sadd') p.sadd(op[1], op[2])
					else p.srem(op[1], op[2])
				}

				const results = (await p.exec()) as Array<[Error | null, unknown]> | null
				for (const [err] of results ?? []) if (err) throw err
			},
			smembers: key => client.smembers(key),
			scanKeys,
			scanDelete: async pattern => {
				const keys = await scanKeys(pattern)
				for (let i = 0; i < keys.length; i += 500) await client.del(...keys.slice(i, i + 500))
				return keys.length
			},
			quit: async () => {
				await client.quit()
			}
		}
	}

	// ---- node-redis v4+ ---------------------------------------------------
	if (typeof client.multi === 'function' && typeof client.sMembers === 'function') {
		const scanKeys = async (pattern: string) => {
			const found: string[] = []
			let cursor: any = '0'
			do {
				const res = await client.scan(String(cursor), { MATCH: pattern, COUNT: 500 })
				cursor = res.cursor
				found.push(...res.keys)
			} while (String(cursor) !== '0')

			return [...new Set(found)]
		}

		return {
			get: key => client.get(key),
			mget: async keys => (keys.length ? client.mGet(keys) : []),
			exec: async ops => {
				if (!ops.length) return
				const m = client.multi()
				for (const op of ops) {
					if (op[0] === 'set') op[3] ? m.set(op[1], op[2], { EX: op[3] }) : m.set(op[1], op[2])
					else if (op[0] === 'del') m.del(op[1])
					else if (op[0] === 'sadd') m.sAdd(op[1], op[2])
					else m.sRem(op[1], op[2])
				}

				await m.exec()
			},
			smembers: key => client.sMembers(key),
			scanKeys,
			scanDelete: async pattern => {
				const keys = await scanKeys(pattern)
				for (let i = 0; i < keys.length; i += 500) await client.del(keys.slice(i, i + 500))
				return keys.length
			},
			quit: async () => {
				await client.quit()
			}
		}
	}

	throw new Error('zenox: unsupported redis client. Pass an `ioredis` or `redis` (node-redis v4+) instance.')
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Create an ioredis client from a URL. `ioredis` is an OPTIONAL dependency
 * (`npm i ioredis`), it is only loaded if you call this.
 */
export async function connectRedis(
	urlOrOptions: string | Record<string, unknown>,
	extra: Record<string, unknown> = {}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const moduleName = 'ioredis'
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mod: any
	try {
		mod = await import(moduleName)
	} catch {
		throw new Error('zenox: redis URL given but `ioredis` is not installed. Run: npm i ioredis')
	}

	const IORedis = mod.default ?? mod
	const defaults = { enableAutoPipelining: true, maxRetriesPerRequest: 3, connectTimeout: 8000 }
	return typeof urlOrOptions === 'string'
		? new IORedis(urlOrOptions, { ...defaults, ...extra })
		: new IORedis({ ...defaults, ...urlOrOptions, ...extra })
}
