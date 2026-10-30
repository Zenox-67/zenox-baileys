/** Minimal logger shape. A `pino` logger satisfies it, so does `console`-style wrappers. */
export interface ZenoxLogger {
	debug(obj: unknown, msg?: string): void
	info(obj: unknown, msg?: string): void
	warn(obj: unknown, msg?: string): void
	error(obj: unknown, msg?: string): void
}

const noop = () => {}

export const silentLogger: ZenoxLogger = { debug: noop, info: noop, warn: noop, error: noop }

/** Default logger: only warnings and errors, prefixed so they are easy to grep. */
export const defaultLogger: ZenoxLogger = {
	debug: noop,
	info: noop,
	warn: (obj, msg) => console.warn('[zenox]', msg ?? '', obj),
	error: (obj, msg) => console.error('[zenox]', msg ?? '', obj)
}

/** `[key, serialisedValue]`; a `null` value means "delete this key". */
export type StorageEntry = [key: string, value: string | null]

/**
 * Low-level persistence used by the auth state. Values are already-serialised strings,
 * so a backend never needs to know about Buffers or Baileys types.
 */
export interface ZenoxStorage {
	readonly name: string
	read(session: string, key: string): Promise<string | null>
	readMany?(session: string, keys: string[]): Promise<Array<string | null>>
	write(session: string, entries: StorageEntry[]): Promise<void>
	/** Synchronous write used as a last resort when the process is exiting. */
	writeSync?(session: string, entries: StorageEntry[]): void
	/** Raw key names of a session (only needed by backends that can be restored from). */
	listKeys?(session: string): Promise<string[]>
	sessions(): Promise<string[]>
	removeSession(session: string): Promise<void>
	close?(): Promise<void>
}

export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Session ids become folder names / redis key segments, so they are strictly validated. */
export const assertSessionId = (id: string): string => {
	if (typeof id !== 'string' || !SESSION_ID_RE.test(id) || id.includes('..')) {
		throw new Error(
			`invalid session id "${String(id)}": use 1-64 chars of letters, digits, ".", "_" or "-" (must start with a letter or digit)`
		)
	}

	return id
}
