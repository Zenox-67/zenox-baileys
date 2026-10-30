import { EventEmitter } from 'events'
import type { RedisOp, ZenoxRedis } from '../redis'

/** In-memory fake that behaves like ioredis (pipeline/scan/mget/sets) so adaptRedis' ioredis branch is exercised. */
export class FakeIORedis {
	data = new Map<string, string>()
	sets = new Map<string, Set<string>>()
	ttls = new Map<string, number>()
	calls = 0
	pipelines = 0
	failing = false

	private check() {
		this.calls++
		if (this.failing) throw new Error('redis down')
	}

	async get(k: string) {
		this.check()
		return this.data.get(k) ?? null
	}

	async mget(...keys: string[]) {
		this.check()
		return keys.map(k => this.data.get(k) ?? null)
	}

	async smembers(k: string) {
		this.check()
		return [...(this.sets.get(k) ?? [])]
	}

	async scan(cursor: string, _m: string, pattern: string) {
		this.check()
		const re = new RegExp('^' + pattern.replace(/\\(.)/g, '$1').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
		return ['0', [...this.data.keys()].filter(k => re.test(k))] as [string, string[]]
	}

	async del(...keys: string[]) {
		this.check()
		for (const k of keys) this.data.delete(k)
		return keys.length
	}

	async quit() {}

	pipeline() {
		this.pipelines++
		const ops: Array<() => void> = []
		const p = {
			set: (k: string, v: string, ex?: string, ttl?: number) => {
				ops.push(() => {
					this.data.set(k, v)
					if (ex === 'EX' && ttl) this.ttls.set(k, ttl)
				})
				return p
			},
			del: (k: string) => (ops.push(() => this.data.delete(k)), p),
			sadd: (k: string, m: string) => (ops.push(() => (this.sets.get(k) ?? this.sets.set(k, new Set()).get(k)!).add(m)), p),
			srem: (k: string, m: string) => (ops.push(() => this.sets.get(k)?.delete(m)), p),
			exec: async () => {
				this.check()
				ops.forEach(o => o())
				return ops.map(() => [null, 'OK'] as [null, string])
			}
		}
		return p
	}
}

export type { RedisOp, ZenoxRedis }

/** Minimal fake of a Baileys socket (only `ev`, `end`, auth state, pairing). */
export class FakeSock {
	ev = new EventEmitter() as EventEmitter & { on: (e: string, l: (...a: any[]) => void) => any }
	ended = 0
	authState = { creds: { registered: false } }
	pairingRequests: string[] = []
	groupMetadataCalls = 0
	constructor(public config: any) {}
	end() {
		this.ended++
	}
	async requestPairingCode(phone: string) {
		this.pairingRequests.push(phone)
		return 'ABCD1234'
	}
	async groupMetadata(jid: string) {
		this.groupMetadataCalls++
		return { id: jid, subject: 'g', participants: [] }
	}
	emit(event: string, payload: any) {
		this.ev.emit(event, payload)
	}
}

export const closeWith = (code: number) => ({
	connection: 'close',
	lastDisconnect: { error: { output: { statusCode: code }, message: `closed ${code}` } }
})

export const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
export const until = async (fn: () => boolean, ms = 2000) => {
	const t0 = Date.now()
	while (!fn()) {
		if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
		await wait(5)
	}
}
