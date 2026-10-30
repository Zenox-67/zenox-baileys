import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createZenoxAuthState } from '../auth-state'
import { MemoryCache, RedisCache, TieredCache } from '../cache'
import { computeReconnectDelay, ZenoxManager, type ZenoxManagerOptions } from '../manager'
import { adaptRedis } from '../redis'
import { FileStorage, MemoryStorage } from '../storage'
import { closeWith, FakeIORedis, FakeSock, until, wait } from './helpers'

const fakeCreds = () => ({ registrationId: 1, noiseKey: { public: Buffer.from([1]), private: Buffer.from([2]) }, registered: false }) as any

const makeManager = (over: Partial<ZenoxManagerOptions<FakeSock>> = {}) => {
	const storage = over.storage ?? new MemoryStorage()
	const socks: FakeSock[] = []
	const mgr = new ZenoxManager<FakeSock>({
		makeSocket: cfg => {
			const s = new FakeSock(cfg)
			socks.push(s)
			return s
		},
		storage,
		hooks: false,
		staggerMs: 0,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		reconnect: { initialDelayMs: 5, maxDelayMs: 40, jitter: 0 },
		network: { check: async () => true }, // tests never touch the real network
		createAuth: id => createZenoxAuthState(storage, id, { initCreds: fakeCreds, flushIntervalMs: 20 }),
		...over
	})
	return { mgr, socks, storage }
}

describe('auth state', () => {
	it('creates + persists creds, round-trips keys and Buffers across a restart', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'zenox-auth-'))
		const a = await createZenoxAuthState(new FileStorage(dir), 'main', { initCreds: fakeCreds, flushIntervalMs: 10_000 })
		assert.equal(a.isNew, true)
		await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([9]), private: Buffer.from([8]) } as any } } as any)
		await a.close()
		assert.ok(readFileSync(join(dir, 'main', 'creds.json'), 'utf-8').includes('"registrationId":1'))

		const b = await createZenoxAuthState(new FileStorage(dir), 'main', { initCreds: () => { throw new Error('must not re-init') }, flushIntervalMs: 10_000 })
		assert.equal(b.isNew, false)
		assert.equal(b.state.creds.registrationId, 1)
		const got = await b.state.keys.get('pre-key', ['1', '2'])
		assert.deepEqual([...(got['1'] as any).public], [9])
		assert.equal(got['2'], null)
		await b.state.keys.set({ 'pre-key': { '1': null as any } })
		assert.equal((await b.state.keys.get('pre-key', ['1']))['1'], null)
		await b.close()
	})

	it('saveCreds is durable immediately (does not wait for the flush interval)', async () => {
		const st = new MemoryStorage()
		const a = await createZenoxAuthState(st, 'main', { initCreds: fakeCreds, flushIntervalMs: 60_000 })
		;(a.state.creds as any).me = { id: '123@s.whatsapp.net' }
		await a.saveCreds()
		assert.match(st.data.get('main')!.get('creds')!, /123@s\.whatsapp\.net/)
		await a.close()
	})

	it('applies reviveKey to app-state-sync-key only', async () => {
		const st = new MemoryStorage()
		const a = await createZenoxAuthState(st, 'main', { initCreds: fakeCreds, reviveKey: (t, v) => (t === 'app-state-sync-key' ? { revived: v } : v) })
		await a.state.keys.set({ 'app-state-sync-key': { k1: { keyData: 'x' } as any }, 'pre-key': { p: { public: Buffer.from([1]), private: Buffer.from([1]) } as any } } as any)
		assert.deepEqual((await a.state.keys.get('app-state-sync-key', ['k1']))['k1'], { revived: { keyData: 'x' } } as any)
		assert.ok(Buffer.isBuffer(((await a.state.keys.get('pre-key', ['p']))['p'] as any).public))
		await a.close()
	})
})

describe('caches', () => {
	it('MemoryCache: TTL expiry and LRU eviction', async () => {
		const c = new MemoryCache({ max: 2, ttlMs: 20 })
		c.set('a', 1); c.set('b', 2); c.set('c', 3)
		assert.equal(c.get('a'), undefined, 'oldest evicted')
		assert.equal(c.get('c'), 3)
		await wait(30)
		assert.equal(c.get('c'), undefined, 'expired')
	})

	it('TieredCache: memory hit is synchronous, redis fills memory, wrap() de-duplicates work', async () => {
		const r = new FakeIORedis()
		const l2 = new RedisCache(adaptRedis(r), { prefix: 'c' })
		const t1 = new TieredCache(new MemoryCache(), l2)
		t1.set('g1', { subject: 'hi' })
		await wait(5)
		const t2 = new TieredCache(new MemoryCache(), l2) // "restarted process"
		assert.deepEqual(await t2.get('g1'), { subject: 'hi' })
		assert.ok(!(t2.get('g1') instanceof Promise), 'second read is served from memory synchronously')

		let runs = 0
		const slow = async () => { runs++; await wait(20); return { v: 1 } }
		const [x, y, z] = await Promise.all([t2.wrap('k', slow), t2.wrap('k', slow), t2.wrap('k', slow)])
		assert.equal(runs, 1)
		assert.deepEqual([x, y, z], [{ v: 1 }, { v: 1 }, { v: 1 }])
		await t2.wrap('k', slow)
		assert.equal(runs, 1, 'cached afterwards')
	})

	it('RedisCache never throws and stops hitting a dead redis (circuit breaker)', async () => {
		const r = new FakeIORedis()
		const c = new RedisCache(adaptRedis(r), { cooldownMs: 50 })
		r.failing = true
		assert.equal(await c.get('x'), undefined)
		const callsAfterFirstFailure = r.calls
		for (let i = 0; i < 20; i++) await c.get('x')
		assert.equal(r.calls, callsAfterFirstFailure, 'no calls during cooldown')
		r.failing = false
		await wait(60)
		await c.set('x', 1)
		assert.equal(await c.get('x'), 1)
	})
})

describe('reconnect', () => {
	it('computeReconnectDelay grows, is capped and jitter stays in range', () => {
		const o = { initialDelayMs: 200, maxDelayMs: 15_000, factor: 1.7, jitter: 0.2 }
		const d = [1, 2, 3, 4, 20].map(n => computeReconnectDelay(n, { ...o, jitter: 0 }))
		assert.deepEqual(d.slice(0, 2), [200, 340])
		assert.ok(d[2]! > d[1]! && d[3]! > d[2]!)
		assert.equal(d[4], 15_000)
		for (let i = 0; i < 200; i++) {
			const v = computeReconnectDelay(3, o)
			assert.ok(v >= 578 * 0.79 && v <= 578 * 1.21, `jitter out of range: ${v}`)
		}
		assert.equal(computeReconnectDelay(1, o, () => 0), 160)
		assert.equal(computeReconnectDelay(1, o, () => 1), 240)
	})

	it('reconnects with a NEW socket, re-runs onSocket handlers, resets attempts on open', async () => {
		const { mgr, socks } = makeManager()
		const seen: number[] = []
		mgr.onSocket((_s, ctx) => { seen.push(ctx.attempt) })
		const events: string[] = []
		mgr.on('reconnecting', e => events.push(`r${e.attempt}`))
		mgr.on('open', e => events.push(e.reconnected ? 'reopen' : 'open'))
		await mgr.start('main')
		socks[0]!.emit('connection.update', { connection: 'open' })
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 2)
		assert.equal(socks[0]!.ended, 1, 'old socket released')
		socks[1]!.emit('connection.update', closeWith(408))
		await until(() => socks.length === 3)
		socks[2]!.emit('connection.update', { connection: 'open' })
		assert.deepEqual(seen, [0, 1, 2], 'handlers attached to every new socket')
		assert.deepEqual(events, ['open', 'r1', 'r2', 'reopen'])
		// attempts were reset by the successful open: next failure is attempt 1 again
		socks[2]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 4)
		assert.equal(events[events.length - 1], 'r1')
		assert.equal(mgr.activity('main')!.current.reconnects, 1)
		await mgr.shutdown('test')
	})

	it('ignores events from old sockets and double close events', async () => {
		const { mgr, socks } = makeManager()
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(428))
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 2)
		await wait(40)
		assert.equal(socks.length, 2, 'only one reconnect was scheduled')
		await mgr.shutdown('test')
	})

	it('code 515 (restart after pairing) reconnects immediately without counting as a failure', async () => {
		const { mgr, socks } = makeManager({ reconnect: { initialDelayMs: 5_000, jitter: 0 } })
		const delays: number[] = []
		mgr.on('reconnecting', e => delays.push(e.delayMs))
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(515))
		await until(() => socks.length === 2, 500)
		assert.deepEqual(delays, [0])
		await mgr.shutdown('test')
	})

	it('code 401 logs out: no reconnect, session data removed', async () => {
		const { mgr, socks, storage } = makeManager()
		await mgr.start('main')
		assert.ok(await storage.read('main', 'creds'))
		let removed: boolean | undefined
		mgr.on('logged-out', e => (removed = e.removed))
		socks[0]!.emit('connection.update', closeWith(401))
		await until(() => removed !== undefined)
		await until(() => mgr.get('main') === undefined)
		await wait(30)
		assert.equal(socks.length, 1)
		assert.equal(await storage.read('main', 'creds'), null)
		await mgr.shutdown('test')
	})

	it('code 401 keeps data when removeOnLogout is false', async () => {
		const { mgr, socks, storage } = makeManager({ reconnect: { removeOnLogout: false, initialDelayMs: 5 } })
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(401))
		await wait(40)
		assert.ok(await storage.read('main', 'creds'))
		assert.equal(socks.length, 1)
		await mgr.shutdown('test')
	})

	it('440 (replaced) and 403 (forbidden) do not reconnect', async () => {
		const { mgr, socks } = makeManager()
		const got: string[] = []
		mgr.on('replaced', () => got.push('replaced')).on('forbidden', () => got.push('forbidden'))
		await mgr.start('a')
		await mgr.start('b')
		socks[0]!.emit('connection.update', closeWith(440))
		socks[1]!.emit('connection.update', closeWith(403))
		await wait(50)
		assert.deepEqual(got, ['replaced', 'forbidden'])
		assert.equal(socks.length, 2)
		await mgr.shutdown('test')
	})

	it('start() revives a session parked by 403/440 instead of returning its dead socket', async () => {
		const { mgr, socks } = makeManager()
		const first = await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(403))
		await wait(20)
		assert.equal(mgr.status('main'), 'stopped')
		const second = await mgr.start('main')
		assert.notEqual(second, first)
		assert.equal(socks.length, 2)
		assert.equal(mgr.status('main'), 'connecting')
		assert.equal(await mgr.start('main'), second, 'a live session is still returned as-is')
		await mgr.shutdown('test')
	})

	it('no internet: goes offline instead of burning attempts, then reconnects at once when it is back', async () => {
		let up = false
		let probes = 0
		const { mgr, socks } = makeManager({
			network: { check: async () => { probes++; return up }, pollMs: 10 },
			reconnect: { initialDelayMs: 2, maxDelayMs: 4, jitter: 0, maxAttempts: 1 }
		})
		const got: string[] = []
		mgr.on('offline', e => got.push(`offline:${e.code}`)).on('online', () => got.push('online')).on('give-up', () => got.push('give-up'))
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(408)) // what Baileys reports for ENOTFOUND / lost connection
		await until(() => mgr.status('main') === 'offline')
		await wait(120) // many polls: with maxAttempts 1 a counted attempt would already have given up
		assert.equal(socks.length, 1, 'no blind reconnect while offline')
		assert.ok(probes >= 5, `kept polling, got ${probes}`)
		assert.deepEqual(got, ['offline:408'], 'offline is announced once, not on every poll')
		up = true
		await until(() => socks.length === 2)
		assert.deepEqual(got, ['offline:408', 'online'])
		assert.equal(mgr.status('main'), 'connecting')
		const types = mgr.activity('main')!.current.events.map(e => e.type)
		assert.ok(types.includes('offline') && types.includes('online'), 'saved in the activity log')
		socks[1]!.emit('connection.update', { connection: 'open' })
		assert.equal(mgr.status('main'), 'open')
		await mgr.shutdown('test')
	})

	it('no internet: shutdown while offline stops everything (no late reconnect)', async () => {
		let up = false
		const { mgr, socks } = makeManager({ network: { check: async () => up, pollMs: 10 } })
		const got: string[] = []
		mgr.on('online', () => got.push('online'))
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => mgr.status('main') === 'offline')
		await mgr.shutdown('test')
		up = true
		await wait(60)
		assert.equal(socks.length, 1)
		assert.deepEqual(got, [])
	})

	it('no internet check is skipped for pairing restarts (515) and when network is false', async () => {
		let probes = 0
		const a = makeManager({ network: { check: async () => { probes++; return true } } })
		await a.mgr.start('main')
		a.socks[0]!.emit('connection.update', closeWith(515))
		await until(() => a.socks.length === 2)
		assert.equal(probes, 0, '515 is a normal restart, nothing to probe')
		await a.mgr.shutdown('test')

		const b = makeManager({ network: false })
		assert.equal(b.mgr.network, undefined)
		await b.mgr.start('main')
		b.socks[0]!.emit('connection.update', closeWith(408))
		await until(() => b.socks.length === 2) // plain backoff reconnect, as before
		await b.mgr.shutdown('test')
	})

	it('gives up after maxAttempts', async () => {
		const { mgr, socks } = makeManager({ reconnect: { initialDelayMs: 2, maxDelayMs: 4, jitter: 0, maxAttempts: 2 } })
		let gaveUp = 0
		mgr.on('give-up', () => gaveUp++)
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 2)
		socks[1]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 3)
		socks[2]!.emit('connection.update', closeWith(428))
		await until(() => gaveUp === 1)
		await wait(30)
		assert.equal(socks.length, 3)
		await mgr.shutdown('test')
	})

	it('a failing makeSocket is retried with backoff instead of killing the session', async () => {
		let n = 0
		const socks: FakeSock[] = []
		const { mgr } = makeManager({
			makeSocket: cfg => {
				if (++n === 2) throw new Error('boom')
				const s = new FakeSock(cfg)
				socks.push(s)
				return s
			}
		})
		await mgr.start('main')
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 2, 1000)
		await mgr.shutdown('test')
	})
})

describe('multi-session, activity, shutdown', () => {
	it('runs sessions independently with isolated storage and caches', async () => {
		const { mgr, socks, storage } = makeManager({
			createCaches: () => ({ groups: new TieredCache(), msgRetryCounterCache: new MemoryCache() })
		})
		await mgr.start('one')
		await mgr.start('two')
		assert.deepEqual(mgr.running().map(r => r.session).sort(), ['one', 'two'])
		assert.notEqual(socks[0]!.config.msgRetryCounterCache, undefined)
		assert.notEqual(socks[0]!.config.auth.keys, socks[1]!.config.auth.keys)
		socks[0]!.emit('connection.update', closeWith(428))
		await until(() => socks.length === 3)
		assert.equal(socks[1]!.ended, 0, 'session two untouched')
		assert.deepEqual((await storage.sessions()).sort(), ['one', 'two'])
		await mgr.shutdown('test')
	})

	it('startAll restores every stored session that has credentials', async () => {
		const storage = new MemoryStorage()
		await storage.write('bot1', [['creds', '{}']])
		await storage.write('bot2', [['creds', '{}']])
		await storage.write('half', [['junk', '1']])
		const { mgr, socks } = makeManager({ storage })
		const started = await mgr.startAll()
		assert.deepEqual(started.sort(), ['bot1', 'bot2'])
		assert.equal(socks.length, 2)
		await mgr.shutdown('test')
	})

	it('saves last activity and detects a crash on the next start', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'zenox-act-'))
		const storage = new FileStorage(dir)
		const first = makeManager({ storage })
		await first.mgr.start('main')
		first.socks[0]!.emit('connection.update', { connection: 'open' })
		first.socks[0]!.emit('messages.upsert', { messages: [{ key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: '1' }, message: {} }], type: 'notify' })
		first.mgr.setMeta('main', { lastCommand: '.menu' })
		// simulate a hard crash: only the synchronous exit-time flush happens
		first.mgr.flushAllSync()

		const second = makeManager({ storage })
		let restored: any
		second.mgr.on('restored', r => (restored = r))
		await second.mgr.start('main')
		assert.equal(restored.crashed, true, 'previous run never shut down cleanly')
		assert.equal(restored.previous.lastMessageJid, 'a@s.whatsapp.net')
		assert.equal(restored.previous.messagesSeen, 1)
		assert.equal(second.mgr.activity('main')!.current.meta.lastCommand, '.menu')
		await second.mgr.shutdown('clean')

		const third = makeManager({ storage })
		let restored3: any
		third.mgr.on('restored', r => (restored3 = r))
		await third.mgr.start('main')
		assert.equal(restored3.crashed, false, 'clean shutdown is remembered')
		assert.equal(restored3.previous.shutdown.reason, 'clean')
		assert.equal(restored3.previous.meta.lastCommand, '.menu')
		await third.mgr.shutdown('test')
	})

	it('shutdown ends sockets WITHOUT reconnecting, flushes pending keys, is idempotent', async () => {
		const { mgr, socks, storage } = makeManager({ createAuth: id => createZenoxAuthState(storage, id, { initCreds: fakeCreds, flushIntervalMs: 60_000 }) })
		await mgr.start('main')
		const auth = socks[0]!.config.auth
		await auth.keys.set({ 'pre-key': { '7': { public: Buffer.from([1]), private: Buffer.from([2]) } } })
		assert.equal((storage as MemoryStorage).data.get('main')!.has('pre-key-7'), false, 'still only in memory')
		const p1 = mgr.shutdown('SIGTERM')
		const p2 = mgr.shutdown('SIGTERM')
		await Promise.all([p1, p2])
		assert.equal(socks[0]!.ended >= 1, true)
		assert.equal((storage as MemoryStorage).data.get('main')!.has('pre-key-7'), true, 'flushed on shutdown')
		assert.equal(JSON.parse((storage as MemoryStorage).data.get('main')!.get('zenox-activity')!).shutdown.reason, 'SIGTERM')
		await wait(30)
		assert.equal(socks.length, 1, 'no reconnect after shutdown')
		await assert.rejects(() => mgr.start('again'), /shutting down/)
	})

	it('flushAllSync saves pending keys when the process is exiting', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'zenox-exit-'))
		const storage = new FileStorage(dir)
		const { mgr, socks } = makeManager({ storage, createAuth: id => createZenoxAuthState(storage, id, { initCreds: fakeCreds, flushIntervalMs: 60_000 }) })
		await mgr.start('main')
		await socks[0]!.config.auth.keys.set({ 'sender-key': { 'g@g.us--1': { a: 1 } } })
		mgr.flushAllSync()
		assert.equal(JSON.parse(readFileSync(join(dir, 'main', 'sender-key-g@g.us--1.json'), 'utf-8')).a, 1)
		await mgr.shutdown('test')
	})

	it('real process hooks are installed and removed cleanly', async () => {
		const before = process.listenerCount('SIGTERM')
		const { mgr } = makeManager({ hooks: { exitOnSignal: false } })
		assert.equal(process.listenerCount('SIGTERM'), before + 1)
		await mgr.shutdown('test')
		assert.equal(process.listenerCount('SIGTERM'), before)
	})

	it('remove() stops a session and deletes its data', async () => {
		const { mgr, storage } = makeManager()
		await mgr.start('main')
		await mgr.remove('main')
		assert.deepEqual(await storage.sessions(), [])
		assert.equal(mgr.get('main'), undefined)
		await mgr.shutdown('test')
	})

	it('rejects invalid session ids', async () => {
		const { mgr } = makeManager()
		await assert.rejects(() => mgr.start('../etc'), /invalid session id/)
		await mgr.shutdown('test')
	})
})

describe('socket wiring', () => {
	it('requests a pairing code once, only when not registered', async () => {
		const { mgr, socks } = makeManager()
		const codes: string[] = []
		mgr.on('pairing-code', c => codes.push(c.code))
		await mgr.start('main', { pairingPhone: '+62 812-3456' })
		socks[0]!.emit('connection.update', { qr: 'QR1' })
		socks[0]!.emit('connection.update', { qr: 'QR2' })
		await until(() => codes.length === 1)
		assert.deepEqual(socks[0]!.pairingRequests, ['628123456'])
		await mgr.shutdown('test')
	})

	it('group metadata: cached, de-duplicated, invalidated by group events', async () => {
		const { mgr, socks } = makeManager({ createCaches: () => ({ groups: new TieredCache() }) })
		await mgr.start('main')
		const s = socks[0]!
		const [a, b] = await Promise.all([s.groupMetadata('g@g.us'), s.groupMetadata('g@g.us')])
		await s.groupMetadata('g@g.us')
		assert.equal(s.groupMetadataCalls, 1)
		assert.equal(a, b)
		assert.equal((await s.config.cachedGroupMetadata('g@g.us')).id, 'g@g.us', 'Baileys sends from the same cache')
		s.emit('group-participants.update', { id: 'g@g.us', participants: [], action: 'add' })
		await s.groupMetadata('g@g.us')
		assert.equal(s.groupMetadataCalls, 2)
		await mgr.shutdown('test')
	})

	it('getMessage serves recently sent messages (for retries) and still honours a user getMessage', async () => {
		const { mgr, socks } = makeManager({ socketConfig: { getMessage: async (k: any) => (k.id === 'user' ? { conversation: 'from user' } : undefined) } })
		await mgr.start('main')
		const s = socks[0]!
		s.emit('messages.upsert', { messages: [{ key: { id: 'sent1', fromMe: true, remoteJid: 'x' }, message: { conversation: 'hi' } }], type: 'append' })
		assert.deepEqual(await s.config.getMessage({ id: 'sent1' }), { conversation: 'hi' })
		assert.deepEqual(await s.config.getMessage({ id: 'user' }), { conversation: 'from user' })
		assert.equal(await s.config.getMessage({ id: 'nope' }), undefined)
		await mgr.shutdown('test')
	})

	it('sent messages survive a restart: a fresh manager answers getMessage from the persistent store', async () => {
		const redis = new FakeIORedis()
		const makeSent = () => {
			const cache = new TieredCache(new MemoryCache(), new RedisCache(adaptRedis(redis), { prefix: 'sent' }))
			return {
				set: (id: string, m: any) => void cache.set(id, Buffer.from(JSON.stringify(m))),
				get: async (id: string) => {
					const raw = await cache.get<Buffer>(id)
					return raw ? JSON.parse(Buffer.from(raw).toString()) : undefined
				}
			}
		}

		const first = makeManager({ createCaches: () => ({ groups: new TieredCache(), sent: makeSent() }) })
		await first.mgr.start('main')
		first.socks[0]!.emit('messages.upsert', {
			messages: [{ key: { id: 'keep-me', fromMe: true, remoteJid: 'x' }, message: { conversation: 'before restart' } }],
			type: 'append'
		})
		await wait(10)
		await first.mgr.shutdown('test')

		const second = makeManager({ createCaches: () => ({ groups: new TieredCache(), sent: makeSent() }) })
		await second.mgr.start('main')
		assert.deepEqual(await second.socks[0]!.config.getMessage({ id: 'keep-me' }), { conversation: 'before restart' })
		assert.equal(await second.socks[0]!.config.getMessage({ id: 'unknown' }), undefined)
		await second.mgr.shutdown('test')
	})

	it('a broken sent-message store never breaks getMessage or message handling', async () => {
		const broken = {
			set: () => {
				throw new Error('encode failed')
			},
			get: async () => {
				throw new Error('redis down')
			}
		}
		const { mgr, socks } = makeManager({ createCaches: () => ({ groups: new TieredCache(), sent: broken }) })
		await mgr.start('main')
		const s = socks[0]!
		s.emit('messages.upsert', { messages: [{ key: { id: 'm1', fromMe: true, remoteJid: 'x' }, message: { conversation: 'hi' } }], type: 'append' })
		assert.deepEqual(await s.config.getMessage({ id: 'm1' }), { conversation: 'hi' }, 'still served from memory')
		assert.equal(await s.config.getMessage({ id: 'other' }), undefined, 'store failure is a miss, not an error')
		await mgr.shutdown('test')
	})

	it('hands mediaCache to Baileys so identical media uploads are reused', async () => {
		const mediaCache = new MemoryCache()
		const { mgr, socks } = makeManager({ createCaches: () => ({ groups: new TieredCache(), mediaCache }) })
		await mgr.start('main')
		assert.equal(socks[0]!.config.mediaCache, mediaCache)
		await mgr.shutdown('test')
	})

	it('saves credentials on creds.update', async () => {
		const { mgr, socks, storage } = makeManager()
		await mgr.start('main')
		;(socks[0]!.config.auth.creds as any).me = { id: '999@s.whatsapp.net' }
		socks[0]!.emit('creds.update', {})
		await until(() => /999@s/.test((storage as MemoryStorage).data.get('main')!.get('creds')!))
		await mgr.shutdown('test')
	})
})
