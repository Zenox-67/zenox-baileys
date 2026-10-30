// Child process used by crash.test.ts: starts one session, writes a key, then dies in the requested way.
import { createZenoxAuthState } from '../auth-state'
import { ZenoxManager } from '../manager'
import { FileStorage } from '../storage'
import { FakeSock } from './helpers'

const [dir, mode] = process.argv.slice(2) as [string, string]
const storage = new FileStorage(dir)
const mgr = new ZenoxManager<FakeSock>({
	makeSocket: cfg => new FakeSock(cfg),
	storage,
	staggerMs: 0,
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	// long flush interval: without the exit hooks this key would be LOST
	createAuth: id => createZenoxAuthState(storage, id, { initCreds: () => ({ registrationId: 7 }) as any, flushIntervalMs: 60_000 })
})

const sock = await mgr.start('main')
await sock.config.auth.keys.set({ 'pre-key': { '42': { public: Buffer.from([1]), private: Buffer.from([2]) } } })
console.log('READY')

if (mode === 'sigterm') setInterval(() => {}, 1000) // wait for the signal
if (mode === 'throw') setTimeout(() => { throw new Error('boom') }, 20)
if (mode === 'exit') setTimeout(() => process.exit(3), 20)
if (mode === 'reject') {
	setInterval(() => {}, 1000)
	setTimeout(() => { Promise.reject(new Error('rejected')) }, 10)
	setTimeout(() => console.log('ALIVE_AFTER_REJECTION'), 30)
}
if (mode === 'natural') {
	// nothing keeps the loop alive: the process ends by itself and beforeExit/exit must save the key
}
