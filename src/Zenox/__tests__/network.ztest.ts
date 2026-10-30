import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { describe, it } from 'node:test'
import { NetworkMonitor } from '../network'
import { wait } from './helpers'

const listen = (): Promise<{ server: Server; port: number; connections: () => number }> =>
	new Promise(resolve => {
		let n = 0
		const server = createServer(sock => {
			n++
			sock.destroy()
		})
		server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, connections: () => n }))
	})

const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

/** a port nobody listens on (connection refused instantly) */
const deadPort = async () => {
	const { server, port } = await listen()
	await close(server)
	return port
}

describe('NetworkMonitor', () => {
	it('is online when a host answers, offline when none does', async () => {
		const live = await listen()
		const up = new NetworkMonitor({ hosts: [{ host: '127.0.0.1', port: live.port }], timeoutMs: 500, cacheMs: 0 })
		assert.equal(await up.check(), true)
		assert.equal(up.online, true)
		await close(live.server)

		const down = new NetworkMonitor({ hosts: [{ host: '127.0.0.1', port: live.port }], timeoutMs: 500, cacheMs: 0 })
		assert.equal(await down.check(), false)
		assert.equal(down.online, false)
	})

	it('one reachable host is enough (a blocked 1.1.1.1 must not look like no internet)', async () => {
		const live = await listen()
		const dead = await deadPort()
		const m = new NetworkMonitor({
			hosts: [{ host: '127.0.0.1', port: dead }, { host: '127.0.0.1', port: live.port }],
			timeoutMs: 500,
			cacheMs: 0
		})
		assert.equal(await m.check(), true)
		await close(live.server)
	})

	it('concurrent checks share one probe and the result is cached briefly', async () => {
		const live = await listen()
		const m = new NetworkMonitor({ hosts: [{ host: '127.0.0.1', port: live.port }], timeoutMs: 500, cacheMs: 300 })
		const results = await Promise.all([m.check(), m.check(), m.check()])
		assert.deepEqual(results, [true, true, true])
		await m.check()
		await wait(20)
		assert.equal(live.connections(), 1, 'one TCP probe served all four calls')
		await wait(350)
		await m.check()
		await wait(20)
		assert.equal(live.connections(), 2, 'after the cache expired a new probe is made')
		await close(live.server)
	})

	it('a custom check is used as-is, and a throwing check counts as online (never blocks reconnecting)', async () => {
		let answer = false
		const m = new NetworkMonitor({ check: async () => answer })
		assert.equal(await m.check(), false)
		answer = true
		assert.equal(await m.check(), true, 'custom checks are not cached')
		const broken = new NetworkMonitor({ check: async () => { throw new Error('boom') } })
		assert.equal(await broken.check(), true)
	})
})
