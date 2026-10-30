import { connect } from 'net'
import { silentLogger, type ZenoxLogger } from './types'

export interface NetworkHost {
	host: string
	port?: number
}

export interface NetworkOptions {
	/** `false` (or `enabled: false`) turns detection off completely. Default true. */
	enabled?: boolean
	/**
	 * Hosts probed with a plain TCP connect (DNS lookup included). The server counts as ONLINE when at least
	 * one answers. Default: `web.whatsapp.com`, `www.google.com`, `one.one.one.one` (all port 443).
	 * Domain names are used on purpose: a DNS failure means WhatsApp is unreachable too, and bare IPs can
	 * "connect" even without internet behind a transparent proxy or captive portal.
	 */
	hosts?: Array<string | NetworkHost>
	/** how long one probe waits per host (default 2500ms) */
	timeoutMs?: number
	/** while offline, how often the connection is checked again (default 3000ms) */
	pollMs?: number
	/** remember the last result for this long so many sessions share one probe (default 1000ms) */
	cacheMs?: number
	/** bring your own check (e.g. when you use a proxy). Return true when the internet works. */
	check?: () => Promise<boolean>
}

export const DEFAULT_NETWORK_HOSTS: NetworkHost[] = [
	{ host: 'web.whatsapp.com', port: 443 },
	{ host: 'www.google.com', port: 443 },
	{ host: 'one.one.one.one', port: 443 }
]

const normalizeHost = (h: string | NetworkHost): Required<NetworkHost> =>
	typeof h === 'string' ? { host: h, port: 443 } : { host: h.host, port: h.port ?? 443 }

/** One TCP connect attempt. Never throws, resolves false on error/timeout. */
export const tcpProbe = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
	new Promise<boolean>(resolve => {
		let done = false
		const socket = connect({ host, port })
		const finish = (ok: boolean) => {
			if (done) return
			done = true
			socket.destroy()
			resolve(ok)
		}

		socket.setTimeout(timeoutMs, () => finish(false))
		socket.once('connect', () => finish(true))
		socket.once('error', () => finish(false))
	})

/**
 * Tells "no internet" apart from "WhatsApp closed the connection".
 * Probes run in parallel and the first host that answers wins, so a healthy connection costs a few ms.
 * Concurrent callers share one probe and the result is cached briefly, so 50 sessions do not mean 50 probes.
 */
export class NetworkMonitor {
	/** last known state: `undefined` until the first check */
	online?: boolean
	readonly pollMs: number

	private readonly hosts: Array<Required<NetworkHost>>
	private readonly timeoutMs: number
	private readonly cacheMs: number
	private readonly custom?: () => Promise<boolean>
	private inflight?: Promise<boolean>
	private last?: { at: number; online: boolean }

	constructor(
		opts: NetworkOptions = {},
		private readonly log: ZenoxLogger = silentLogger
	) {
		this.hosts = (opts.hosts?.length ? opts.hosts : DEFAULT_NETWORK_HOSTS).map(normalizeHost)
		this.timeoutMs = opts.timeoutMs ?? 2500
		this.pollMs = opts.pollMs ?? 3000
		this.cacheMs = opts.cacheMs ?? 1000
		this.custom = opts.check
	}

	/** true = internet reachable. Never throws. */
	check(): Promise<boolean> {
		if (this.custom) return this.run() // custom checks are never cached/coalesced: the caller owns that logic
		if (this.last && Date.now() - this.last.at < this.cacheMs) return Promise.resolve(this.last.online)
		this.inflight ??= this.run().finally(() => {
			this.inflight = undefined
		})
		return this.inflight
	}

	private async run(): Promise<boolean> {
		let online: boolean
		try {
			online = this.custom ? !!(await this.custom()) : await this.probeAll()
		} catch (err) {
			this.log.warn({ err }, 'zenox: network check failed, assuming online')
			online = true // a broken checker must never block reconnecting
		}

		this.last = { at: Date.now(), online }
		this.online = online
		return online
	}

	private probeAll(): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			let left = this.hosts.length
			for (const { host, port } of this.hosts) {
				tcpProbe(host, port, this.timeoutMs).then(ok => {
					if (ok) resolve(true)
					else if (--left === 0) resolve(false)
				})
			}
		})
	}
}
