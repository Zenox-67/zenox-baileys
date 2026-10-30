import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { WriteBehindStore, type WriteBehindOptions } from './write-behind'
import type { ZenoxStorage } from './types'

export interface ZenoxAuthOptions extends WriteBehindOptions {
	/** creates fresh credentials (Baileys' `initAuthCreds`) */
	initCreds: () => AuthenticationCreds
	/** turn a stored plain object back into the class Baileys expects (app-state-sync-key) */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reviveKey?: (type: string, value: any) => any
}

export interface ZenoxAuthHandle {
	/** pass `state.creds` / `state.keys` to `makeWASocket({ auth })` */
	state: AuthenticationState
	/** call on every `creds.update`; resolves once credentials are really saved */
	saveCreds: () => Promise<void>
	store: WriteBehindStore
	/** true when no credentials existed (needs QR / pairing code) */
	isNew: boolean
	flush: () => Promise<void>
	flushSync: () => boolean
	close: () => Promise<void>
	/** delete the whole session from storage */
	clear: () => Promise<void>
}

/**
 * Drop-in alternative to `useMultiFileAuthState` with memory-first reads,
 * batched write-behind saves and pluggable storage (file / redis / mirror).
 */
export async function createZenoxAuthState(
	storage: ZenoxStorage,
	session: string,
	opts: ZenoxAuthOptions
): Promise<ZenoxAuthHandle> {
	const store = new WriteBehindStore(storage, session, opts)

	let creds = await store.get<AuthenticationCreds>('creds')
	const isNew = !creds
	if (!creds) {
		creds = opts.initCreds()
		store.set('creds', creds)
		await store.flush()
	}

	const state: AuthenticationState = {
		creds,
		keys: {
			get: async (type, ids) => {
				const values = await store.getMany<unknown>(ids.map(id => `${type}-${id}`))
				const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
				ids.forEach((id, i) => {
					let v = values[i] ?? null
					if (v && opts.reviveKey) v = opts.reviveKey(type, v)
					out[id] = v as SignalDataTypeMap[typeof type]
				})
				return out
			},
			set: async data => {
				for (const category in data) {
					const items = data[category as keyof SignalDataTypeMap]
					for (const id in items) {
						store.set(`${category}-${id}`, items[id] ?? null)
					}
				}
			}
		}
	}

	return {
		state,
		isNew,
		store,
		saveCreds: async () => {
			store.set('creds', state.creds)
			await store.flush()
		},
		flush: () => store.flush(),
		flushSync: () => store.flushSync(),
		close: () => store.close(),
		clear: () => store.clear()
	}
}
