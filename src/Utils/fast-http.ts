/**
 * Zenox fast HTTP client.
 *
 * Why it exists: the default `fetch` of Node closes idle connections after about 4 seconds and resolves DNS on every new
 * connection. A bot that calls the same API (or the WhatsApp CDN) every few seconds therefore pays DNS + TCP + TLS again
 * and again. This client keeps connections open longer, caches DNS lookups, retries when a reused connection turned out
 * to be dead, decompresses gzip/deflate/brotli, follows redirects and can retry transient failures.
 *
 * It only depends on Node built-ins, so it can be used on its own:
 *
 *   const http = createHttpClient()
 *   const res = await http.get('https://example.com/api')
 *   const data = await res.json()
 *
 * `http.fetch` is a drop-in for the global `fetch` (handy for SDKs that accept a custom `fetch`).
 */
import * as dns from 'dns'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'http'
import { Agent as HttpsAgent, request as httpsRequest } from 'https'
import { isIP } from 'net'
import { PassThrough, Readable } from 'stream'
import * as zlib from 'zlib'

// ---------------------------------------------------------------------------------------------------------------------
// DNS cache
// ---------------------------------------------------------------------------------------------------------------------

const DNS_TTL_MS = 60_000
const DNS_MAX_ENTRIES = 256

type DnsEntry = { addrs: dns.LookupAddress[]; expires: number }
const dnsCache = new Map<string, DnsEntry>()
const dnsInflight = new Map<string, Promise<dns.LookupAddress[]>>()
const dnsStats = { hits: 0, misses: 0 }

/** Forget cached addresses (all hosts, or one host). Useful after a network change. */
export const clearDnsCache = (hostname?: string) => {
	if (!hostname) {
		dnsCache.clear()
		return
	}

	for (const key of [...dnsCache.keys()]) {
		if (key.startsWith(hostname + '|')) dnsCache.delete(key)
	}
}

/** Drop-in for `dns.lookup` (the `lookup` option of sockets/agents) that remembers answers for 60 seconds. */
export const cachedLookup = (hostname: string, options: any, callback?: any) => {
	let cb = callback
	let opts = options
	if (typeof options === 'function') {
		cb = options
		opts = {}
	}

	opts = typeof opts === 'number' ? { family: opts } : opts || {}

	// literal IPs and localhost-style names need no cache
	if (isIP(hostname)) {
		return dns.lookup(hostname, opts, cb)
	}

	const key = `${hostname}|${opts.family ?? 0}|${opts.hints ?? 0}`
	const reply = (addrs: dns.LookupAddress[]) => {
		if (opts.all) {
			cb(null, addrs)
		} else {
			const first = addrs[0]!
			cb(null, first.address, first.family)
		}
	}

	const hit = dnsCache.get(key)
	if (hit && hit.expires > Date.now()) {
		dnsStats.hits++
		process.nextTick(() => reply(hit.addrs))
		return
	}

	dnsStats.misses++
	let pending = dnsInflight.get(key)
	if (!pending) {
		pending = dns.promises.lookup(hostname, { ...opts, all: true }) as unknown as Promise<dns.LookupAddress[]>
		dnsInflight.set(key, pending)
		const done = () => dnsInflight.delete(key)
		pending.then(done, done)
	}

	pending.then(
		addrs => {
			if (!addrs.length) {
				cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }))
				return
			}

			dnsCache.set(key, { addrs, expires: Date.now() + DNS_TTL_MS })
			if (dnsCache.size > DNS_MAX_ENTRIES) {
				dnsCache.delete(dnsCache.keys().next().value!)
			}

			reply(addrs)
		},
		err => cb(err)
	)
}

// ---------------------------------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------------------------------

export type FastHttpHeaders = Record<string, string | number | undefined | null> | Headers | [string, string][]

export type FastHttpOptions = {
	method?: string
	headers?: FastHttpHeaders
	/** string / Buffer / Uint8Array / URLSearchParams / Readable */
	body?: string | Buffer | Uint8Array | URLSearchParams | Readable | null
	/** Sends this value as JSON (sets the body and `content-type`) */
	json?: unknown
	/** Maximum wait for the response headers, including DNS, connect and TLS. Default 30000 */
	timeoutMs?: number
	/** Maximum silence while the body is being received. Default 60000 */
	idleTimeoutMs?: number
	/** How many extra attempts after a transient failure (network error, 408/425/429/5xx). Default 0 */
	retries?: number
	/** First wait between attempts; doubles each time (with jitter). Default 200 */
	retryDelayMs?: number
	/** Also retry non-idempotent methods (POST...). Default false */
	retryNonIdempotent?: boolean
	/** Status codes worth retrying. Default 408, 425, 429, 500, 502, 503, 504 */
	retryOn?: number[]
	/** Default 5. Use 0 to receive 3xx responses as they are */
	maxRedirects?: number
	/** Largest body `buffer()/text()/json()` will read. Default unlimited */
	maxBytes?: number
	/** Ask for and decode gzip/deflate/br. Default true */
	compress?: boolean
	signal?: AbortSignal | null
	/** Use your own agent (proxy, custom TLS...) instead of the shared keep-alive agent */
	agent?: HttpAgent | HttpsAgent
}

export class FastHttpError extends Error {
	code: string
	status?: number
	url?: string
	constructor(message: string, code: string, extra: { status?: number; url?: string } = {}) {
		super(message)
		this.name = 'FastHttpError'
		this.code = code
		if (extra.status !== undefined) this.status = extra.status
		if (extra.url !== undefined) this.url = extra.url
	}
}

export class FastResponse {
	readonly status: number
	readonly statusText: string
	readonly ok: boolean
	/** Final URL (after redirects) */
	readonly url: string
	readonly redirected: boolean
	/** Header names are lower-case; repeated headers (set-cookie) are arrays */
	readonly headers: Record<string, string | string[]>
	/** Body, already decompressed. Read it once: either through this stream or through buffer()/text()/json() */
	readonly stream: Readable
	private used = false
	private readonly maxBytes: number

	constructor(init: {
		status: number
		statusText: string
		url: string
		redirected: boolean
		headers: Record<string, string | string[]>
		stream: Readable
		maxBytes: number
	}) {
		this.status = init.status
		this.statusText = init.statusText
		this.ok = init.status >= 200 && init.status < 300
		this.url = init.url
		this.redirected = init.redirected
		this.headers = init.headers
		this.stream = init.stream
		this.maxBytes = init.maxBytes
	}

	header(name: string): string | undefined {
		const value = this.headers[name.toLowerCase()]
		return Array.isArray(value) ? value[0] : value
	}

	async buffer(): Promise<Buffer> {
		if (this.used) throw new FastHttpError('body already consumed', 'EBODYUSED', { url: this.url })
		this.used = true
		const chunks: Buffer[] = []
		let size = 0
		try {
			for await (const chunk of this.stream) {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
				size += buf.length
				if (size > this.maxBytes) {
					throw new FastHttpError(`response larger than ${this.maxBytes} bytes`, 'ETOOBIG', { url: this.url })
				}

				chunks.push(buf)
			}
		} catch (err) {
			this.stream.destroy()
			throw err
		}

		return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
	}

	async text(): Promise<string> {
		return (await this.buffer()).toString('utf8')
	}

	async json<T = any>(): Promise<T> {
		return JSON.parse(await this.text()) as T
	}

	/** Throws a FastHttpError when the status is not 2xx, otherwise returns itself */
	assertOk(): this {
		if (!this.ok) {
			this.stream.destroy()
			throw new FastHttpError(`HTTP ${this.status} ${this.statusText} for ${this.url}`, 'EHTTPSTATUS', {
				status: this.status,
				url: this.url
			})
		}

		return this
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])
const DEFAULT_RETRY_ON = [408, 425, 429, 500, 502, 503, 504]
const TRANSIENT_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EPIPE',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'ENOTFOUND',
	'EZENOXTIMEOUT',
	'EZENOXSTALE',
	'UND_ERR_SOCKET'
])
const DNS_SUSPECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const normalizeHeaders = (input?: FastHttpHeaders): Record<string, string> => {
	const out: Record<string, string> = {}
	if (!input) return out
	const put = (k: string, v: unknown) => {
		if (v === undefined || v === null) return
		out[k.toLowerCase()] = String(v)
	}

	if (typeof (input as Headers).forEach === 'function' && !Array.isArray(input)) {
		;(input as Headers).forEach((v, k) => put(k, v))
	} else if (Array.isArray(input)) {
		for (const [k, v] of input) put(k, v)
	} else {
		for (const [k, v] of Object.entries(input)) put(k, v)
	}

	return out
}

const inflate = (res: IncomingMessage, wanted: boolean) => {
	const encoding = String(res.headers['content-encoding'] || '')
		.trim()
		.toLowerCase()
	const hasBody = !(res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304)
	let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined
	if (wanted && hasBody) {
		if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip()
		else if (encoding === 'deflate') decoder = zlib.createInflate()
		else if (encoding === 'br') decoder = zlib.createBrotliDecompress()
	}

	const out: PassThrough | zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress = decoder ?? new PassThrough()
	res.on('error', (err: Error) => out.destroy(err))
	// the consumer left early: do not keep a half-read connection in the pool
	out.on('close', () => {
		if (!res.complete) res.destroy()
	})
	res.pipe(out)
	return { stream: out, decoded: !!decoder }
}

export type FastHttpStats = {
	requests: number
	/** requests that reused an open connection */
	reusedConnections: number
	retries: number
	dnsHits: number
	dnsMisses: number
}

// ---------------------------------------------------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------------------------------------------------

export type HttpClientOptions = FastHttpOptions & {
	/** Max parallel connections per host. Default 64 */
	maxSockets?: number
	/** How long an idle connection stays open for reuse. Default 30000 */
	keepAliveMs?: number
	/** Cache DNS answers for 60 s. Default true */
	dnsCache?: boolean
	/** Sent when the caller gives no user-agent. Default "node" (same as the built-in fetch) */
	userAgent?: string
}

export const createHttpClient = (defaults: HttpClientOptions = {}) => {
	const { maxSockets = 64, keepAliveMs = 30_000, dnsCache: useDnsCache = true, userAgent = 'node', ...requestDefaults } = defaults

	const agentOptions = {
		keepAlive: true,
		keepAliveMsecs: 10_000,
		maxSockets,
		maxFreeSockets: Math.min(32, maxSockets),
		scheduling: 'lifo' as const,
		timeout: keepAliveMs,
		noDelay: true,
		...(useDnsCache ? { lookup: cachedLookup as any } : {})
	}
	let httpAgent: HttpAgent | undefined
	let httpsAgent: HttpsAgent | undefined
	const agentFor = (protocol: string): HttpAgent | HttpsAgent =>
		protocol === 'https:' ? (httpsAgent ??= new HttpsAgent(agentOptions)) : (httpAgent ??= new HttpAgent(agentOptions))

	const stats: FastHttpStats = { requests: 0, reusedConnections: 0, retries: 0, dnsHits: 0, dnsMisses: 0 }
	const dnsBase = { hits: dnsStats.hits, misses: dnsStats.misses }

	/** one HTTP exchange, no retry, no redirect */
	const exchange = (
		url: URL,
		method: string,
		headers: Record<string, string>,
		body: Buffer | Readable | undefined,
		opts: FastHttpOptions
	) =>
		new Promise<IncomingMessage>((resolve, reject) => {
			const isHttps = url.protocol === 'https:'
			const timeoutMs = opts.timeoutMs ?? 30_000
			let settled = false
			let timer: NodeJS.Timeout | undefined
			let onAbort: (() => void) | undefined

			const finish = (fn: () => void) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
				fn()
			}

			const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
			const req = (isHttps ? httpsRequest : httpRequest)({
				protocol: url.protocol,
				hostname,
				port: url.port || undefined,
				path: url.pathname + url.search,
				method,
				headers,
				agent: opts.agent ?? agentFor(url.protocol)
			})

			stats.requests++
			req.on('socket', () => {
				if (req.reusedSocket) stats.reusedConnections++
			})
			req.on('response', res => finish(() => resolve(res)))
			req.on('error', (err: NodeJS.ErrnoException) => {
				finish(() => {
					const code = err.code
					// a pooled connection that the server had already closed: the request never reached it
					if (req.reusedSocket && (code === 'ECONNRESET' || code === 'EPIPE')) {
						reject(Object.assign(err, { code: 'EZENOXSTALE' }))
						return
					}

					if (code && DNS_SUSPECT_CODES.has(code)) clearDnsCache(hostname)
					reject(err)
				})
			})

			timer = setTimeout(() => {
				req.destroy(new FastHttpError(`no response from ${url.host} after ${timeoutMs} ms`, 'EZENOXTIMEOUT', { url: url.href }))
			}, timeoutMs)

			if (opts.signal) {
				if (opts.signal.aborted) {
					req.destroy(new FastHttpError('aborted', 'EABORT', { url: url.href }))
				} else {
					onAbort = () => req.destroy(new FastHttpError('aborted', 'EABORT', { url: url.href }))
					opts.signal.addEventListener('abort', onAbort, { once: true })
				}
			}

			if (body instanceof Readable) {
				body.on('error', err => req.destroy(err))
				body.pipe(req)
			} else {
				req.end(body)
			}
		})

	const requestOnce = async (target: string | URL, init: FastHttpOptions): Promise<FastResponse> => {
		const opts: FastHttpOptions = { ...requestDefaults, ...init }
		let url = new URL(target.toString())
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new FastHttpError(`unsupported protocol ${url.protocol}`, 'EPROTOCOL', { url: url.href })
		}

		let method = (opts.method || (opts.body != null || opts.json !== undefined ? 'POST' : 'GET')).toUpperCase()
		const headers = { ...normalizeHeaders(requestDefaults.headers), ...normalizeHeaders(init.headers) }
		let body: Buffer | Readable | undefined

		if (opts.json !== undefined) {
			body = Buffer.from(JSON.stringify(opts.json))
			headers['content-type'] ??= 'application/json'
		} else if (opts.body instanceof Readable) {
			body = opts.body
		} else if (typeof opts.body === 'string') {
			body = Buffer.from(opts.body)
		} else if (opts.body instanceof URLSearchParams) {
			body = Buffer.from(opts.body.toString())
			headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'
		} else if (opts.body) {
			body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength)
		}

		headers['user-agent'] ??= userAgent
		headers['accept'] ??= '*/*'
		const compress = opts.compress !== false
		headers['accept-encoding'] ??= compress ? 'gzip, deflate, br' : 'identity'
		if (body && !(body instanceof Readable)) headers['content-length'] = String(body.length)
		else if (!body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) headers['content-length'] = '0'

		const maxRedirects = opts.maxRedirects ?? 5
		let redirects = 0
		const originalOrigin = url.origin

		for (;;) {
			if (url.username || url.password) {
				const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
				headers['authorization'] ??= 'Basic ' + Buffer.from(credentials).toString('base64')
			}

			headers['host'] = url.host
			const res = await exchange(url, method, headers, body, opts)
			const status = res.statusCode || 0
			const location = res.headers.location

			if (REDIRECT_STATUS.has(status) && location && redirects < maxRedirects) {
				res.resume()
				redirects++
				url = new URL(location, url)
				if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
					method = method === 'HEAD' ? 'HEAD' : 'GET'
					body = undefined
					delete headers['content-type']
					delete headers['content-length']
				} else if (body instanceof Readable) {
					throw new FastHttpError('cannot follow a redirect with a streamed body', 'EREDIRECTBODY', { url: url.href })
				}

				if (url.origin !== originalOrigin) {
					delete headers['authorization']
					delete headers['cookie']
				}

				continue
			}

			const idle = opts.idleTimeoutMs ?? 60_000
			res.setTimeout(idle, () => res.destroy(new FastHttpError(`no data for ${idle} ms`, 'EZENOXIDLE', { url: url.href })))

			const { stream, decoded } = inflate(res, compress && method !== 'HEAD')
			const responseHeaders: Record<string, string | string[]> = {}
			for (const [k, v] of Object.entries(res.headers)) {
				if (v === undefined) continue
				if (decoded && (k === 'content-encoding' || k === 'content-length')) continue
				responseHeaders[k] = v
			}

			return new FastResponse({
				status,
				statusText: res.statusMessage || '',
				url: url.href,
				redirected: redirects > 0,
				headers: responseHeaders,
				stream,
				maxBytes: opts.maxBytes ?? Infinity
			})
		}
	}

	/** Sends a request. Resolves when the headers arrive; read the body with `.buffer()`, `.json()`, `.text()` or `.stream`. */
	const request = async (target: string | URL, init: FastHttpOptions = {}): Promise<FastResponse> => {
		const opts: FastHttpOptions = { ...requestDefaults, ...init }
		const method = (opts.method || (opts.body != null || opts.json !== undefined ? 'POST' : 'GET')).toUpperCase()
		const canRetry = (IDEMPOTENT.has(method) || opts.retryNonIdempotent === true) && !(opts.body instanceof Readable)
		const attempts = 1 + Math.max(0, opts.retries ?? 0)
		const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON
		let delay = opts.retryDelayMs ?? 200
		let staleRetried = false

		for (let attempt = 1; ; attempt++) {
			try {
				const res = await requestOnce(target, init)
				if (canRetry && attempt < attempts && retryOn.includes(res.status)) {
					const retryAfter = Number(res.header('retry-after'))
					res.stream.destroy()
					stats.retries++
					await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : delay * (0.75 + Math.random() * 0.5))
					delay *= 2
					continue
				}

				return res
			} catch (err: any) {
				// a dead pooled connection says nothing about the server: try once more on a fresh one, whatever the method
				if (err?.code === 'EZENOXSTALE' && !staleRetried && !(opts.body instanceof Readable)) {
					staleRetried = true
					attempt--
					stats.retries++
					continue
				}

				if (err?.code === 'EZENOXSTALE') err.code = 'ECONNRESET'
				const transient = TRANSIENT_CODES.has(err?.code)
				if (canRetry && transient && attempt < attempts) {
					stats.retries++
					await sleep(delay * (0.75 + Math.random() * 0.5))
					delay *= 2
					continue
				}

				throw err
			}
		}
	}

	const get = (url: string | URL, init: FastHttpOptions = {}) => request(url, { ...init, method: 'GET' })
	const post = (url: string | URL, init: FastHttpOptions = {}) => request(url, { ...init, method: 'POST' })

	/** GET/POST and parse JSON; throws on non-2xx */
	const getJson = async <T = any>(url: string | URL, init: FastHttpOptions = {}): Promise<T> =>
		(await get(url, init)).assertOk().json<T>()
	const postJson = async <T = any>(url: string | URL, data: unknown, init: FastHttpOptions = {}): Promise<T> =>
		(await post(url, { ...init, json: data })).assertOk().json<T>()

	/**
	 * Opens (and keeps) a connection to a host so the first real request skips DNS + TCP + TLS. Never throws.
	 * Uses GET with a 1-byte range, not HEAD: Node does not return a socket to the pool after HEAD.
	 */
	const preconnect = async (target: string | URL, timeoutMs = 4000): Promise<boolean> => {
		try {
			const origin = new URL(target.toString()).origin
			const res = await request(origin + '/', {
				timeoutMs,
				maxRedirects: 0,
				compress: false,
				maxBytes: 64 * 1024,
				headers: { range: 'bytes=0-0' }
			})
			// wait for the end so the connection is back in the pool when we return
			await res.buffer()
			return true
		} catch {
			return false
		}
	}

	/** `fetch`-compatible function (returns a standard `Response`). Unsupported inputs fall back to the global fetch. */
	const fetchLike = async (input: any, init: any = {}): Promise<Response> => {
		const fallback = () => (globalThis.fetch as any)(input, init)
		if (typeof input !== 'string' && !(input instanceof URL)) return fallback()
		if (init.redirect === 'error') return fallback()
		if (init.dispatcher) return fallback()

		const rawBody = init.body
		let body: FastHttpOptions['body']
		if (rawBody == null || typeof rawBody === 'string' || Buffer.isBuffer(rawBody) || rawBody instanceof URLSearchParams) {
			body = rawBody
		} else if (rawBody instanceof Uint8Array) {
			body = rawBody
		} else if (rawBody instanceof ArrayBuffer) {
			body = Buffer.from(rawBody)
		} else {
			return fallback() // FormData, Blob, web streams
		}

		const res = await request(input, {
			method: init.method,
			headers: init.headers,
			body,
			signal: init.signal,
			maxRedirects: init.redirect === 'manual' ? 0 : 5,
			// the caller of fetch() expects the raw behaviour: no automatic retry
			retries: 0
		})

		const headers = new Headers()
		for (const [k, v] of Object.entries(res.headers)) {
			for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item)
		}

		const noBody = res.status === 204 || res.status === 205 || res.status === 304 || (init.method || '').toUpperCase() === 'HEAD'
		const response = new Response(noBody ? null : (Readable.toWeb(res.stream) as any), {
			status: res.status,
			statusText: res.statusText,
			headers
		})
		if (noBody) res.stream.resume()
		Object.defineProperty(response, 'url', { value: res.url })
		Object.defineProperty(response, 'redirected', { value: res.redirected })
		return response
	}

	return {
		request,
		get,
		post,
		getJson,
		postJson,
		preconnect,
		fetch: fetchLike as typeof fetch,
		/** The pooled agent (keep-alive + DNS cache), e.g. to pass as `agent` to another library */
		agent: (protocol: 'http:' | 'https:' = 'https:') => agentFor(protocol),
		stats: (): FastHttpStats => ({
			...stats,
			dnsHits: dnsStats.hits - dnsBase.hits,
			dnsMisses: dnsStats.misses - dnsBase.misses
		}),
		/** Closes idle connections. The client keeps working afterwards (new connections are opened on demand). */
		destroy: () => {
			httpAgent?.destroy()
			httpsAgent?.destroy()
			httpAgent = undefined
			httpsAgent = undefined
		}
	}
}

export type FastHttpClient = ReturnType<typeof createHttpClient>

let shared: FastHttpClient | undefined

/** The client Baileys itself uses for media downloads and link previews. Created on first use. */
export const getSharedHttp = (): FastHttpClient => (shared ??= createHttpClient())

/** Shortcut: `fetch`-compatible function backed by the shared keep-alive client */
export const zenoxFetch: typeof fetch = ((input: any, init?: any) => getSharedHttp().fetch(input, init)) as typeof fetch

let enabled = true

/** Turn the fast client off for Baileys' own downloads (they go back to the global fetch). Default: on. */
export const setFastHttpEnabled = (value: boolean) => {
	enabled = value
}

export const isFastHttpEnabled = () =>
	enabled &&
	typeof process !== 'undefined' &&
	!!process.versions?.node &&
	typeof process.versions.bun === 'undefined' &&
	typeof (globalThis as any).Deno === 'undefined' &&
	process.env.ZENOX_FAST_HTTP !== '0'
