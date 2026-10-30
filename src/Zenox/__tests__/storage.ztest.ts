import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { zxParse, zxReplacer, zxStringify } from '../serializer'
import { FileStorage, MemoryStorage, MirrorStorage, RedisStorage } from '../storage'
import { WriteBehindStore } from '../write-behind'
import { FakeIORedis, until, wait } from './helpers'

const tmp = () => mkdtempSync(join(tmpdir(), 'zenox-'))

describe('serializer', () => {
	it('round-trips Buffer and Uint8Array', () => {
		const v = { a: Buffer.from([1, 2, 3]), b: new Uint8Array([4, 5]), c: { d: 'x' } }
		const back = zxParse<any>(zxStringify(v))
		assert.ok(Buffer.isBuffer(back.a))
		assert.deepEqual([...back.a], [1, 2, 3])
		assert.deepEqual([...back.b], [4, 5])
		assert.equal(back.c.d, 'x')
	})

	it('is byte-compatible with the Baileys BufferJSON format ({type:"Buffer", data:<base64>})', () => {
		const json = zxStringify({ k: Buffer.from('hello') })
		assert.equal(json, JSON.stringify({ k: { type: 'Buffer', data: Buffer.from('hello').toString('base64') } }))
		assert.equal(zxReplacer('', 5), 5)
	})
})

describe('FileStorage', () => {
	it('writes atomically, reads, deletes, lists sessions', async () => {
		const dir = tmp()
		const fs = new FileStorage(dir)
		await fs.write('main', [['creds', '{"a":1}'], ['pre-key-1', '{"b":2}']])
		assert.equal(await fs.read('main', 'creds'), '{"a":1}')
		assert.equal(await fs.read('main', 'nope'), null)
		assert.equal(await fs.read('main', 'pre-key-1'), '{"b":2}')
		assert.deepEqual(await fs.sessions(), ['main'])
		await fs.write('main', [['pre-key-1', null], ['never-existed', null]])
		assert.equal(await fs.read('main', 'pre-key-1'), null)
		assert.ok(!readdirSync(join(dir, 'main')).some(f => f.endsWith('.tmp')), 'no temp files left behind')
		await fs.removeSession('main')
		assert.deepEqual(await fs.sessions(), [])
	})

	it('uses the same file names as useMultiFileAuthState, so old sessions open as-is', async () => {
		const dir = tmp()
		mkdirSync(join(dir, 'baileys_auth_info'))
		writeFileSync(join(dir, 'baileys_auth_info', 'creds.json'), '{"registered":true}')
		writeFileSync(join(dir, 'baileys_auth_info', 'session-123-5@s.whatsapp.net.0.json'), '{"x":1}')
		const fs = new FileStorage(dir)
		assert.equal(await fs.read('baileys_auth_info', 'creds'), '{"registered":true}')
		// ':' is replaced by '-' exactly like Baileys does
		assert.equal(await fs.read('baileys_auth_info', 'session-123:5@s.whatsapp.net.0'), '{"x":1}')
		await fs.write('baileys_auth_info', [['app-state-sync-key-a/b', '{}']])
		assert.ok(existsSync(join(dir, 'baileys_auth_info', 'app-state-sync-key-a__b.json')))
	})

	it('rejects path traversal in session ids', async () => {
		const fs = new FileStorage(tmp())
		for (const bad of ['../evil', 'a/b', '..', '', '.hidden', 'x'.repeat(65), 'a b']) {
			await assert.rejects(() => fs.write(bad, [['creds', '{}']]), /invalid session id/)
		}
	})

	it('writeSync works (used while the process is exiting)', () => {
		const dir = tmp()
		const fs = new FileStorage(dir)
		fs.writeSync('s1', [['creds', '{"z":1}']])
		assert.equal(readFileSync(join(dir, 's1', 'creds.json'), 'utf-8'), '{"z":1}')
		fs.writeSync('s1', [['creds', null]])
		assert.ok(!existsSync(join(dir, 's1', 'creds.json')))
	})
})

describe('RedisStorage (ioredis-shaped client)', () => {
	it('stores with ONE pipeline per batch, reads with ONE mget, tracks sessions, removes by scan', async () => {
		const r = new FakeIORedis()
		const st = new RedisStorage(r, { prefix: 'zx', ttlSeconds: 100 })
		await st.write('main', [['creds', '1'], ['a', '2'], ['b', '3']])
		assert.equal(r.pipelines, 1)
		assert.equal(r.ttls.get('zx:main:k:creds'), 100)
		assert.deepEqual(await st.readMany('main', ['a', 'b', 'zzz']), ['2', '3', null])
		assert.deepEqual(await st.sessions(), ['main'])
		assert.deepEqual((await st.listKeys('main')).sort(), ['a', 'b', 'creds'])
		await st.write('other', [['creds', 'x']])
		await st.removeSession('main')
		assert.deepEqual(await st.sessions(), ['other'])
		assert.equal(await st.read('main', 'creds'), null)
		assert.equal(await st.read('other', 'creds'), 'x')
	})
})

describe('MirrorStorage (local file + remote redis)', () => {
	it('reads come from local only, writes replicate to remote', async () => {
		const r = new FakeIORedis()
		const m = new MirrorStorage(new FileStorage(tmp()), new RedisStorage(r))
		await m.write('s', [['creds', '{"v":1}'], ['k', '{"v":2}']])
		const callsAfterWrite = r.calls
		assert.equal(await m.read('s', 'creds'), '{"v":1}')
		assert.deepEqual(await m.readMany('s', ['k']), ['{"v":2}'])
		assert.equal(r.calls, callsAfterWrite, 'no redis traffic for reads')
		assert.equal(r.data.get('zenox:s:k:k'), '{"v":2}')
	})

	it('restores a session from redis onto a wiped disk', async () => {
		const r = new FakeIORedis()
		const before = new MirrorStorage(new FileStorage(tmp()), new RedisStorage(r))
		await before.write('s', [['creds', '{"v":1}'], ['pre-key-9', '{"v":9}']])
		const freshDisk = new MirrorStorage(new FileStorage(tmp()), new RedisStorage(r))
		assert.equal(await freshDisk.read('s', 'creds'), '{"v":1}')
		assert.equal(await freshDisk.read('s', 'pre-key-9'), '{"v":9}')
		assert.deepEqual(await freshDisk.sessions(), ['s'])
	})

	it('a dead redis never fails or blocks a write, entries are replayed later', async () => {
		const r = new FakeIORedis()
		const m = new MirrorStorage(new FileStorage(tmp()), new RedisStorage(r))
		r.failing = true
		await m.write('s', [['creds', '1']])
		assert.equal(m.backlogSize, 1)
		assert.equal(await m.read('s', 'creds'), '1')
		r.failing = false
		await m.write('s', [['k', '2']])
		assert.equal(m.backlogSize, 0)
		assert.equal(r.data.get('zenox:s:k:creds'), '1', 'backlog replayed')
		assert.equal(r.data.get('zenox:s:k:k'), '2')
	})
})

describe('WriteBehindStore', () => {
	it('writes only touch memory until the flush, reads see pending writes', async () => {
		const st = new MemoryStorage()
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000 })
		wb.set('k1', { a: 1 })
		wb.set('k2', { a: 2 })
		assert.equal(st.data.get('s'), undefined, 'nothing written yet')
		assert.deepEqual(await wb.get('k1'), { a: 1 })
		assert.deepEqual(await wb.getMany(['k1', 'k2', 'k3']), [{ a: 1 }, { a: 2 }, null])
		await wb.flush()
		assert.equal(st.data.get('s')?.get('k1'), '{"a":1}')
		await wb.close()
	})

	it('deletes: a pending delete hides the stale stored value', async () => {
		const st = new MemoryStorage()
		await st.write('s', [['k', '{"a":1}']])
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000 })
		assert.deepEqual(await wb.get('k'), { a: 1 })
		wb.set('k', null)
		assert.equal(await wb.get('k'), null)
		await wb.flush()
		assert.equal(st.data.get('s')?.has('k'), false)
		await wb.close()
	})

	it('snapshots the value at set() time (later mutation does not change what is saved)', async () => {
		const st = new MemoryStorage()
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000 })
		const v = { n: 1 }
		wb.set('k', v)
		v.n = 99
		await wb.flush()
		assert.equal(st.data.get('s')?.get('k'), '{"n":1}')
		await wb.close()
	})

	it('flushes by itself after the interval and when maxPending is reached', async () => {
		const st = new MemoryStorage()
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 20, maxPending: 3 })
		wb.set('a', 1)
		await wait(60)
		assert.equal(st.data.get('s')?.get('a'), '1')
		wb.set('b', 2); wb.set('c', 3); wb.set('d', 4)
		await wait(10)
		assert.equal(st.data.get('s')?.get('d'), '4', 'maxPending triggers an immediate flush')
		await wb.close()
	})

	it('a failing storage keeps the data and retries, nothing is lost', async () => {
		const st = new MemoryStorage()
		let fail = true
		const orig = st.write.bind(st)
		st.write = async (s, e) => { if (fail) throw new Error('disk full'); return orig(s, e) }
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 15 })
		wb.set('k', { v: 1 })
		await assert.rejects(() => wb.flush(), /disk full/)
		assert.equal(wb.pendingCount, 1)
		fail = false
		await wait(60) // the automatic retry
		assert.equal(st.data.get('s')?.get('k'), '{"v":1}')
		await wb.close()
	})

	it('a storage that keeps failing is retried with backoff, never in a tight loop (writeThrough too)', async () => {
		const st = new MemoryStorage()
		let attempts = 0
		let fail = true
		const orig = st.write.bind(st)
		st.write = async (s, e) => { attempts++; if (fail) throw new Error('disk full'); return orig(s, e) }
		const wb = new WriteBehindStore(st, 's', { writeThrough: true, flushIntervalMs: 50 })
		wb.set('k', { v: 1 })
		await wait(400) // the event loop must stay alive (a hot retry loop would freeze this timer forever)
		assert.ok(attempts >= 2 && attempts <= 8, `expected a few spaced retries, got ${attempts}`)
		wb.set('k', { v: 2 }) // new writes while failing must not trigger extra immediate attempts
		const before = attempts
		await wait(5)
		assert.equal(attempts, before)
		fail = false
		await until(() => st.data.get('s')?.get('k') === '{"v":2}', 3000)
		await wb.close()
	})

	it('a newer write wins over the requeued one after a failed flush', async () => {
		const st = new MemoryStorage()
		let fail = true
		const orig = st.write.bind(st)
		st.write = async (s, e) => { if (fail) throw new Error('x'); return orig(s, e) }
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000 })
		wb.set('k', 'old')
		const p = wb.flush().catch(() => {})
		wb.set('k', 'new') // arrives while the failing flush is running
		await p
		fail = false
		await wb.flush()
		assert.equal(zxParse(st.data.get('s')!.get('k')!), 'new')
		await wb.close()
	})

	it('flushSync saves pending data through writeSync', () => {
		const st = new MemoryStorage()
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000 })
		wb.set('k', { z: 1 })
		assert.equal(wb.flushSync(), true)
		assert.equal(st.data.get('s')?.get('k'), '{"z":1}')
		assert.equal(wb.pendingCount, 0)
	})

	it('LRU cache is bounded but never loses pending data', async () => {
		const st = new MemoryStorage()
		const wb = new WriteBehindStore(st, 's', { flushIntervalMs: 10_000, cacheSize: 3 })
		for (let i = 0; i < 10; i++) wb.set(`k${i}`, i)
		for (let i = 0; i < 10; i++) assert.equal(await wb.get(`k${i}`), i)
		await wb.flush()
		for (let i = 0; i < 10; i++) assert.equal(await wb.get(`k${i}`), i, 'evicted keys are re-read from storage')
		await wb.close()
	})

	it('a corrupt stored value is ignored instead of crashing', async () => {
		const st = new MemoryStorage()
		await st.write('s', [['bad', '{not json']])
		const wb = new WriteBehindStore(st, 's')
		assert.equal(await wb.get('bad'), null)
		await wb.close()
	})
})
