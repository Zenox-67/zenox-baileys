import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createReactor, parseReactArgs } from '../react'

const gate = () => {
	let open!: () => void
	const promise = new Promise<void>(r => (open = r))
	return { promise, open }
}
const tick = () => new Promise<void>(r => setImmediate(r))

describe('reactor', () => {
	it('sends one reaction', async () => {
		const sent: string[] = []
		const r = createReactor({ send: async (_j, _k, e) => void sent.push(e) })
		const res = await r.react('g@g.us', { id: 'M1' }, '✅')
		assert.equal(res.status, 'sent')
		assert.deepEqual(sent, ['✅'])
	})

	it('keeps order and drops a stale queued reaction (⏳ in flight, 🤔 then ✅ queued -> only ✅ follows)', async () => {
		const sent: string[] = []
		const g = gate()
		const r = createReactor({
			send: async (_j, _k, e) => {
				if (e === '⏳') await g.promise
				sent.push(e)
			}
		})
		const a = r.react('c@s.whatsapp.net', { id: 'M1' }, '⏳')
		await tick()
		const b = r.react('c@s.whatsapp.net', { id: 'M1' }, '🤔')
		const c = r.react('c@s.whatsapp.net', { id: 'M1' }, '✅')
		g.open()
		const [ra, rb, rc] = await Promise.all([a, b, c])
		assert.equal(ra.status, 'sent')
		assert.deepEqual(rb, { status: 'skipped', reason: 'superseded' })
		assert.equal(rc.status, 'sent')
		assert.deepEqual(sent, ['⏳', '✅'])
	})

	it('does not send the same emoji twice', async () => {
		let n = 0
		const r = createReactor({ send: async () => void n++ })
		await r.react('a', { id: '1' }, '👍')
		const again = await r.react('a', { id: '1' }, '👍')
		assert.deepEqual(again, { status: 'skipped', reason: 'same-emoji' })
		assert.equal(n, 1)
		await r.react('a', { id: '1' }, '') // removing a reaction is a different state
		assert.equal(n, 2)
	})

	it('different messages do not wait for each other', async () => {
		const g = gate()
		const sent: string[] = []
		const r = createReactor({
			send: async (_j, k) => {
				if (k.id === 'slow') await g.promise
				sent.push(k.id!)
			}
		})
		const slow = r.react('a', { id: 'slow' }, '⏳')
		await r.react('a', { id: 'fast' }, '⏳')
		assert.deepEqual(sent, ['fast'])
		g.open()
		await slow
	})

	it('wait:false returns at once and logs a failure instead of throwing', async () => {
		const warnings: unknown[] = []
		const r = createReactor({
			send: async () => {
				throw new Error('offline')
			},
			log: { debug() {}, info() {}, error() {}, warn: o => void warnings.push(o) }
		})
		const res = await r.react('a', { id: '1' }, '✅', { wait: false })
		assert.deepEqual(res, { status: 'queued' })
		await new Promise(resolve => setTimeout(resolve, 10))
		assert.equal(warnings.length, 1)
		await assert.rejects(r.react('a', { id: '2' }, '✅'), /offline/)
	})

	it('a failed send can be retried with the same emoji', async () => {
		let fail = true
		const r = createReactor({
			send: async () => {
				if (fail) throw new Error('x')
			}
		})
		await assert.rejects(r.react('a', { id: '1' }, '✅'))
		fail = false
		assert.equal((await r.react('a', { id: '1' }, '✅')).status, 'sent')
	})

	it('requires a message id', async () => {
		const r = createReactor({ send: async () => {} })
		await assert.rejects(r.react('a', {}, '✅'), /no id/)
	})
})

describe('parseReactArgs', () => {
	it('accepts (message, emoji) and (jid, key, emoji)', () => {
		const m = { key: { remoteJid: 'g@g.us', id: 'M', participant: 'p@s.whatsapp.net' } }
		assert.deepEqual(parseReactArgs(m, '✅', undefined, undefined), { jid: 'g@g.us', key: m.key, emoji: '✅', opts: {} })
		assert.deepEqual(parseReactArgs(m, '✅', { wait: false }, undefined).opts, { wait: false })
		assert.deepEqual(parseReactArgs('x@g.us', { id: 'K' }, '👍', { wait: false }), {
			jid: 'x@g.us',
			key: { id: 'K' },
			emoji: '👍',
			opts: { wait: false }
		})
		assert.throws(() => parseReactArgs({}, '✅', undefined, undefined))
	})
})
