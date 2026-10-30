import type { WriteBehindStore } from './write-behind'

export interface ZenoxActivityEvent {
	t: number
	type: string
	data?: unknown
}

export interface ZenoxActivity {
	session: string
	status: string
	startedAt: number
	lastOpenAt?: number
	lastCloseAt?: number
	lastCloseCode?: number
	lastMessageAt?: number
	lastMessageJid?: string
	messagesSeen: number
	reconnects: number
	/** set on a clean shutdown. If it is missing on the next start, the process died unexpectedly. */
	shutdown?: { reason: string; at: number }
	/** the last lifecycle events (open, close, reconnecting, shutdown ...) */
	events: ZenoxActivityEvent[]
	/** free-form data your bot wants to survive restarts (last command, counters ...) */
	meta: Record<string, unknown>
}

const KEY = 'zenox-activity'

/**
 * Remembers what a session was doing, saves it with the same write-behind
 * mechanism as the keys (so it is also saved on shutdown / crash).
 */
export class ActivityTracker {
	private timer?: ReturnType<typeof setTimeout>
	private dirty = false

	private constructor(
		private readonly store: WriteBehindStore,
		readonly current: ZenoxActivity,
		/** what was stored by the previous run (undefined on the very first start) */
		readonly previous: ZenoxActivity | undefined,
		private readonly maxEvents: number,
		private readonly persistMs: number
	) {}

	static async load(store: WriteBehindStore, session: string, maxEvents = 50, persistMs = 1000) {
		const previous = (await store.get<ZenoxActivity>(KEY)) ?? undefined
		const current: ZenoxActivity = {
			session,
			status: 'starting',
			startedAt: Date.now(),
			lastOpenAt: previous?.lastOpenAt,
			lastCloseAt: previous?.lastCloseAt,
			lastCloseCode: previous?.lastCloseCode,
			lastMessageAt: previous?.lastMessageAt,
			lastMessageJid: previous?.lastMessageJid,
			messagesSeen: previous?.messagesSeen ?? 0,
			reconnects: previous?.reconnects ?? 0,
			shutdown: undefined,
			events: (previous?.events ?? []).slice(-maxEvents),
			meta: { ...(previous?.meta ?? {}) }
		}
		const tracker = new ActivityTracker(store, current, previous, maxEvents, persistMs)
		tracker.touch() // clears `shutdown` on disk: from now on a missing marker means "crashed"
		return tracker
	}

	/** true when the previous run started but never reached a clean shutdown */
	get crashedLastTime() {
		return !!this.previous && !this.previous.shutdown
	}

	record(type: string, data?: unknown) {
		this.current.events.push({ t: Date.now(), type, data })
		if (this.current.events.length > this.maxEvents) this.current.events.splice(0, this.current.events.length - this.maxEvents)
		this.touch()
	}

	patch(partial: Partial<Omit<ZenoxActivity, 'session' | 'meta' | 'events'>>) {
		Object.assign(this.current, partial)
		this.touch()
	}

	/** merge data into `meta`, it is persisted and available as `previous.meta` after a restart */
	setMeta(patch: Record<string, unknown>) {
		Object.assign(this.current.meta, patch)
		this.touch()
	}

	markShutdown(reason: string) {
		this.current.shutdown = { reason, at: Date.now() }
		this.current.status = 'stopped'
		this.record('shutdown', { reason })
	}

	private touch() {
		this.dirty = true
		if (this.timer) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			this.persist()
		}, this.persistMs)
		this.timer.unref?.()
	}

	/** push the latest state into the store (the store then flushes it to disk/redis) */
	persist() {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		if (!this.dirty) return
		this.dirty = false
		this.store.set(KEY, this.current)
	}
}
