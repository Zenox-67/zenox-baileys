/**
 * Warm-up: do the slow first-time work before the bot needs it.
 *
 * Without it, the first message to every group makes WhatsApp's server answer a "who is in this group" query, and the first
 * upload opens a fresh connection (DNS + TCP + TLS) to the media server. Those are the "bot is slow at first, faster later" delays.
 */
import type { ZenoxLogger } from './types'

export type WarmupOptions = {
	/** load every group you are in into the cache right after connecting (default true) */
	groups?: boolean
	/** wait this long after connecting before loading groups, so the first messages are not delayed (default 1500) */
	groupsDelayMs?: number
	/** fetch the media upload server and open a connection to it (default true) */
	media?: boolean
	/** when a message arrives, load that group / the sender's devices in the background so the reply is faster (default true) */
	onMessage?: boolean
	/** other hosts to open a connection to in advance, e.g. your API: `['https://nio-api-zenox.vercel.app']` */
	preconnect?: string[]
}

export type WarmSock = {
	authState?: { creds?: { me?: { id?: string; lid?: string } } }
	groupFetchAllParticipating?: () => Promise<Record<string, { id?: string } & Record<string, unknown>>>
	groupMetadata?: (jid: string) => Promise<unknown>
	refreshMediaConn?: (force: boolean) => Promise<{ hosts: { hostname: string }[] }>
	getUSyncDevices?: (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => Promise<unknown>
}

export type WarmCtx = {
	session: string
	/** group cache; `setLocal` fills memory only (no redis traffic for hundreds of groups) */
	groups?: { setLocal?: (key: string, value: unknown) => void; get: (key: string) => unknown }
	log: ZenoxLogger
	stale: () => boolean
}

export type WarmupDeps = {
	preconnect: (url: string) => Promise<unknown>
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

const userOf = (jid?: string) => jid?.split('@')[0]?.split(':')[0]
const serverOf = (jid?: string) => jid?.split('@')[1]

export const createWarmup = (opts: WarmupOptions = {}, deps: WarmupDeps) => {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
	const now = deps.now ?? Date.now
	const prefetched = new Map<string, number>()
	const PREFETCH_EVERY_MS = 4 * 60_000

	const onOpen = async (sock: WarmSock, ctx: WarmCtx) => {
		const jobs: Promise<unknown>[] = []

		if (opts.media !== false && sock.refreshMediaConn) {
			jobs.push(
				(async () => {
					const conn = await sock.refreshMediaConn!(false)
					const host = conn.hosts[0]?.hostname
					if (host && !ctx.stale()) await deps.preconnect(`https://${host}`)
				})()
			)
		}

		for (const url of opts.preconnect ?? []) jobs.push(deps.preconnect(url))

		if (opts.groups !== false && sock.groupFetchAllParticipating && ctx.groups?.setLocal) {
			jobs.push(
				(async () => {
					await sleep(opts.groupsDelayMs ?? 1500)
					if (ctx.stale()) return
					const all = await sock.groupFetchAllParticipating!()
					if (ctx.stale()) return
					let count = 0
					for (const [id, meta] of Object.entries(all ?? {})) {
						ctx.groups!.setLocal!(`group:${meta?.id ?? id}`, meta)
						count++
					}

					ctx.log.debug({ session: ctx.session, groups: count }, 'zenox: warm-up loaded groups')
				})()
			)
		}

		const results = await Promise.allSettled(jobs)
		for (const r of results) {
			if (r.status === 'rejected') ctx.log.debug({ session: ctx.session, err: r.reason }, 'zenox: warm-up step failed')
		}
	}

	const onMessages = (sock: WarmSock, messages: { key?: { remoteJid?: string | null; fromMe?: boolean | null } }[], ctx: WarmCtx) => {
		if (opts.onMessage === false) return
		for (const m of messages) {
			const jid = m?.key?.remoteJid
			if (!jid || m.key?.fromMe || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue
			const last = prefetched.get(jid)
			const t = now()
			if (last !== undefined && t - last < PREFETCH_EVERY_MS) continue
			prefetched.set(jid, t)
			if (prefetched.size > 2000) prefetched.delete(prefetched.keys().next().value!)

			let job: Promise<unknown> | undefined
			if (jid.endsWith('@g.us')) {
				// goes through the cached sock.groupMetadata: fills the cache, and shares the query with a send that starts meanwhile
				job = sock.groupMetadata?.(jid)
			} else {
				const me = sock.authState?.creds?.me
				const server = serverOf(jid)
				const own = server === 'lid' && me?.lid ? `${userOf(me.lid)}@lid` : me?.id ? `${userOf(me.id)}@s.whatsapp.net` : undefined
				if (own && sock.getUSyncDevices) job = sock.getUSyncDevices([own, jid], true, false)
			}

			job?.catch?.(err => {
				prefetched.delete(jid) // try again on the next message
				ctx.log.debug({ session: ctx.session, jid, err }, 'zenox: prefetch failed')
			})
		}
	}

	return { onOpen, onMessages }
}

export type Warmup = ReturnType<typeof createWarmup>
