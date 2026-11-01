import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import * as zlib from 'node:zlib'
import { createHttpClient, FastHttpError } from '../../Utils/fast-http'

let hits = 0
let flaky = 0
const server = createServer((req, res) => {
	hits++
	const url = new URL(req.url!, 'http://x')
	if (url.pathname === '/json') {
		const body = Buffer.from(JSON.stringify({ ok: true, ua: req.headers['user-agent'] }))
		if (String(req.headers['accept-encoding']).includes('gzip')) {
			res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
			res.end(zlib.gzipSync(body))
		} else {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(body)
		}
	} else if (url.pathname === '/echo') {
		const chunks: Buffer[] = []
		req.on('data', c => chunks.push(c))
		req.on('end', () => {
			res.writeHead(200, { 'content-type': String(req.headers['content-type']) })
			res.end(Buffer.concat(chunks))
		})
	} else if (url.pathname === '/redirect') {
		res.writeHead(302, { location: '/json' })
		res.end()
	} else if (url.pathname === '/flaky') {
		flaky++
		if (flaky < 3) {
			res.writeHead(503, { 'retry-after': '0' })
			res.end('busy')
		} else {
			res.end('fine')
		}
	} else if (url.pathname === '/big') {
		res.end(Buffer.alloc(5000, 1))
	} else if (url.pathname === '/slow') {
		setTimeout(() => res.end('late'), 500)
	} else {
		res.writeHead(404)
		res.end('nope')
	}
})
let base = ''

before(async () => {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => {
	server.closeAllConnections()
	server.close()
})

describe('fast http client', () => {
	it('gets JSON and decodes gzip', async () => {
		const http = createHttpClient()
		const data = await http.getJson(base + '/json')
		assert.equal(data.ok, true)
		assert.equal(data.ua, 'node')
		http.destroy()
	})

	it('reuses the connection between requests', async () => {
		const http = createHttpClient()
		for (let i = 0; i < 5; i++) await (await http.get(base + '/json')).buffer()
		const s = http.stats()
		assert.equal(s.requests, 5)
		assert.equal(s.reusedConnections, 4)
		http.destroy()
	})

	it('posts json and form bodies', async () => {
		const http = createHttpClient()
		const a = await http.post(base + '/echo', { json: { a: 1 } })
		assert.deepEqual(await a.json(), { a: 1 })
		const b = await http.post(base + '/echo', { body: new URLSearchParams({ x: 'y z' }) })
		assert.equal(await b.text(), 'x=y+z')
		http.destroy()
	})

	it('follows redirects and can be told not to', async () => {
		const http = createHttpClient()
		const r = await http.get(base + '/redirect')
		assert.equal(r.status, 200)
		assert.equal(r.redirected, true)
		await r.buffer()
		const m = await http.get(base + '/redirect', { maxRedirects: 0 })
		assert.equal(m.status, 302)
		http.destroy()
	})

	it('retries 503 for GET only when asked', async () => {
		const http = createHttpClient()
		flaky = 0
		const plain = await http.get(base + '/flaky')
		assert.equal(plain.status, 503)
		plain.stream.destroy()
		flaky = 0
		const retried = await http.get(base + '/flaky', { retries: 3, retryDelayMs: 5 })
		assert.equal(await retried.text(), 'fine')
		assert.ok(http.stats().retries >= 2)
		http.destroy()
	})

	it('retries on a fresh connection when the pooled one was closed by the server', async () => {
		const http = createHttpClient()
		await (await http.get(base + '/json')).buffer()
		server.closeIdleConnections() // server drops the pooled socket behind our back
		const res = await http.get(base + '/json')
		assert.equal(res.status, 200)
		await res.buffer()
		http.destroy()
	})

	it('times out waiting for headers and enforces maxBytes', async () => {
		const http = createHttpClient()
		await assert.rejects(http.get(base + '/slow', { timeoutMs: 100 }), (e: any) => e instanceof FastHttpError && e.code === 'EZENOXTIMEOUT')
		const big = await http.get(base + '/big', { maxBytes: 100 })
		await assert.rejects(big.buffer(), (e: any) => e.code === 'ETOOBIG')
		http.destroy()
	})

	it('assertOk throws on 404', async () => {
		const http = createHttpClient()
		await assert.rejects(http.getJson(base + '/missing'), (e: any) => e.status === 404)
		http.destroy()
	})

	it('fetch-compatible wrapper returns a standard Response', async () => {
		const http = createHttpClient()
		const res = await http.fetch(base + '/json', { headers: { accept: 'application/json' } })
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('content-type'), 'application/json')
		assert.equal(((await res.json()) as any).ok, true)
		const posted = await http.fetch(base + '/echo', { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } })
		assert.equal(await posted.text(), 'hello')
		const buf = await (await http.fetch(base + '/big')).arrayBuffer()
		assert.equal(buf.byteLength, 5000)
		http.destroy()
	})

	it('preconnect warms a connection', async () => {
		const http = createHttpClient()
		assert.equal(await http.preconnect(base), true)
		await (await http.get(base + '/json')).buffer()
		assert.equal(http.stats().reusedConnections, 1)
		http.destroy()
	})
})
