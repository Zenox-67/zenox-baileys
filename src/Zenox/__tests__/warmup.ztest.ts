import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWarmup, type WarmCtx } from '../warmup'

const log = { debug() {}, info() {}, warn() {}, error() {} }
const makeCtx = (over: Partial<WarmCtx> = {}) => {
	const store = new Map<string, unknown>()
	const ctx: WarmCtx = {
		session: 'main',
		groups: { setLocal: (k, v) => void store.set(k, v), get: k => store.get(k) },
		log,
		stale: () => false,
		...over
	}
	return { ctx, store }
}

describe('warm-up on open', () => {
	it('loads groups into the cache, fetches the media host and opens connections', async () => {
		const preconnected: string[] = []
		const w = createWarmup({ groupsDelayMs: 0, preconnect: ['https://api.example.com'] }, { preconnect: async u => void preconnected.push(u) })
		const { ctx, store } = makeCtx()
		await w.onOpen(
			{
				refreshMediaConn: async () => ({ hosts: [{ hostname: 'upload.example.net' }] }),
				groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us' }, 'b@g.us': { id: 'b@g.us' } })
			},
			ctx
		)
		assert.deepEqual([...store.keys()].sort(), ['group:a@g.us', 'group:b@g.us'])
		assert.deepEqual(preconnected.sort(), ['https://api.example.com', 'https://upload.example.net'])
	})

	it('can be switched off per step, and a failing step does not stop the others', async () => {
		const preconnected: string[] = []
		const w = createWarmup({ groupsDelayMs: 0, groups: false }, { preconnect: async u => void preconnected.push(u) })
		const { ctx, store } = makeCtx()
		await w.onOpen(
			{
				refreshMediaConn: async () => {
					throw new Error('boom')
				},
				groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us' } })
			},
			ctx
		)
		assert.equal(store.size, 0)
		assert.deepEqual(preconnected, [])
	})

	it('does nothing once the socket was replaced', async () => {
		const w = createWarmup({ groupsDelayMs: 0 }, { preconnect: async () => {} })
		let calls = 0
		const { ctx, store } = makeCtx({ stale: () => true })
		await w.onOpen(
			{
				groupFetchAllParticipating: async () => {
					calls++
					return {}
				}
			},
			ctx
		)
		assert.equal(calls, 0)
		assert.equal(store.size, 0)
	})
})

describe('prefetch on incoming messages', () => {
	it('loads the group metadata once per group in a while', async () => {
		let t = 1000
		const w = createWarmup({}, { preconnect: async () => {}, now: () => t })
		const seen: string[] = []
		const sock = { groupMetadata: async (jid: string) => void seen.push(jid) }
		const msg = { key: { remoteJid: 'g@g.us', fromMe: false } }
		w.onMessages(sock, [msg, msg], makeCtx().ctx)
		t += 60_000
		w.onMessages(sock, [msg], makeCtx().ctx)
		assert.deepEqual(seen, ['g@g.us'])
		t += 5 * 60_000
		w.onMessages(sock, [msg], makeCtx().ctx)
		assert.deepEqual(seen, ['g@g.us', 'g@g.us'])
	})

	it('loads the device list of a private chat (own user + contact), skips own, status and newsletters', () => {
		const w = createWarmup({}, { preconnect: async () => {} })
		const calls: string[][] = []
		const sock = {
			authState: { creds: { me: { id: '6281:12@s.whatsapp.net', lid: '999:12@lid' } } },
			getUSyncDevices: async (jids: string[]) => void calls.push(jids)
		}
		const ctx = makeCtx().ctx
		w.onMessages(
			sock,
			[
				{ key: { remoteJid: '6282@s.whatsapp.net' } },
				{ key: { remoteJid: '1234@lid' } },
				{ key: { remoteJid: '6283@s.whatsapp.net', fromMe: true } },
				{ key: { remoteJid: 'status@broadcast' } },
				{ key: { remoteJid: '1@newsletter' } }
			],
			ctx
		)
		assert.deepEqual(calls, [
			['6281@s.whatsapp.net', '6282@s.whatsapp.net'],
			['999@lid', '1234@lid']
		])
	})

	it('can be disabled and retries after a failure', async () => {
		const off = createWarmup({ onMessage: false }, { preconnect: async () => {} })
		let n = 0
		off.onMessages({ groupMetadata: async () => void n++ }, [{ key: { remoteJid: 'g@g.us' } }], makeCtx().ctx)
		assert.equal(n, 0)

		const on = createWarmup({}, { preconnect: async () => {} })
		let tries = 0
		const sock = {
			groupMetadata: async () => {
				tries++
				throw new Error('x')
			}
		}
		on.onMessages(sock, [{ key: { remoteJid: 'g@g.us' } }], makeCtx().ctx)
		await new Promise(r => setTimeout(r, 5))
		on.onMessages(sock, [{ key: { remoteJid: 'g@g.us' } }], makeCtx().ctx)
		assert.equal(tries, 2)
	})
})
