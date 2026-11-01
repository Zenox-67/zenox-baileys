/**
 * Fast emoji reactions: `sock.react(message, '✅')`.
 *
 * What it adds on top of `sock.sendMessage(jid, { react })`:
 *  - one reaction at a time per message, in order: a late "⏳" can never land after "✅";
 *  - a reaction that has not left yet is replaced by the newer one (⏳ then ✅ in quick succession sends only ✅);
 *  - the same emoji twice is not sent twice;
 *  - `{ wait: false }` returns at once and sends in the background (errors are logged, not thrown).
 *
 * The network time of a single reaction is WhatsApp's; this removes everything around it.
 */
import type { ZenoxLogger } from './types'

export type ReactKey = {
	remoteJid?: string | null
	id?: string | null
	fromMe?: boolean | null
	participant?: string | null
}

export type ReactOptions = {
	/** `false`: return immediately and send in the background. Default true (resolves after the reaction was sent). */
	wait?: boolean
}

export type ReactResult =
	| { status: 'sent'; message?: unknown }
	| { status: 'skipped'; reason: 'same-emoji' | 'superseded' }
	| { status: 'queued' }

type Waiter = { resolve: (r: ReactResult) => void; reject: (e: unknown) => void }
type Lane = {
	running: boolean
	current?: string
	last?: string
	pending?: { emoji: string; waiters: Waiter[] }
}

export type ReactorDeps = {
	send: (jid: string, key: ReactKey, emoji: string) => Promise<unknown>
	log?: ZenoxLogger
	/** how long an idle lane is remembered for the same-emoji check (default 60 s) */
	idleMs?: number
}

const MAX_LANES = 5000

export const createReactor = ({ send, log, idleMs = 60_000 }: ReactorDeps) => {
	const lanes = new Map<string, Lane>()

	const pump = async (laneKey: string, lane: Lane, jid: string, key: ReactKey) => {
		lane.running = true
		while (lane.pending) {
			const job = lane.pending
			lane.pending = undefined
			lane.current = job.emoji
			try {
				const message = await send(jid, key, job.emoji)
				lane.last = job.emoji
				for (const w of job.waiters) w.resolve({ status: 'sent', message })
			} catch (err) {
				for (const w of job.waiters) w.reject(err)
			}
		}

		lane.running = false
		lane.current = undefined
		const timer = setTimeout(() => {
			if (lanes.get(laneKey) === lane && !lane.running && !lane.pending) lanes.delete(laneKey)
		}, idleMs)
		timer.unref?.()
	}

	const react = (jid: string, key: ReactKey, emoji: string, opts: ReactOptions = {}): Promise<ReactResult> => {
		if (!key?.id) return Promise.reject(new Error('react: the message key has no id'))
		const laneKey = `${jid}|${key.id}`
		let lane = lanes.get(laneKey)
		if (!lane) {
			if (lanes.size >= MAX_LANES) {
				for (const [k, l] of lanes) {
					if (!l.running && !l.pending) lanes.delete(k)
					if (lanes.size < MAX_LANES) break
				}
			}

			lane = { running: false }
			lanes.set(laneKey, lane)
		}

		// an older reaction that has not been sent yet is not worth sending any more
		if (lane.pending) {
			const old = lane.pending
			lane.pending = undefined
			for (const w of old.waiters) w.resolve({ status: 'skipped', reason: 'superseded' })
		}

		const alreadyThere = lane.running ? lane.current === emoji : lane.last === emoji
		if (alreadyThere) return Promise.resolve({ status: 'skipped', reason: 'same-emoji' })

		const result = new Promise<ReactResult>((resolve, reject) => {
			lane!.pending = { emoji, waiters: [{ resolve, reject }] }
		})
		if (!lane.running) void pump(laneKey, lane, jid, { ...key, remoteJid: key.remoteJid ?? jid })

		if (opts.wait === false) {
			result.catch(err => log?.warn({ err, jid, emoji }, 'zenox: background reaction failed'))
			return Promise.resolve({ status: 'queued' })
		}

		return result
	}

	return { react, size: () => lanes.size }
}

export type Reactor = ReturnType<typeof createReactor>

/** Accepts both `react(message, emoji)` and `react(jid, key, emoji)` */
export const parseReactArgs = (
	a: unknown,
	b: unknown,
	c: unknown,
	d: unknown
): { jid: string; key: ReactKey; emoji: string; opts: ReactOptions } => {
	if (typeof a === 'string') {
		return { jid: a, key: b as ReactKey, emoji: String(c ?? ''), opts: (d as ReactOptions) ?? {} }
	}

	const message = a as { key?: ReactKey }
	const key = message?.key
	if (!key?.remoteJid) throw new Error('react: pass a message (with .key.remoteJid) or (jid, key, emoji)')
	return { jid: key.remoteJid, key, emoji: String(b ?? ''), opts: (c as ReactOptions) ?? {} }
}
