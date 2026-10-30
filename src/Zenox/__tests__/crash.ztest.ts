import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const child = join(import.meta.dirname, 'crash-child.ts')
// in the repo `tsx` is a devDependency; set ZENOX_TSX to an absolute loader path if it is installed elsewhere
const tsxImport = process.env.ZENOX_TSX ?? 'tsx'

const run = (mode: string, signal?: NodeJS.Signals) =>
	new Promise<{ code: number | null; sig: NodeJS.Signals | null; dir: string; out: string }>((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), 'zenox-crash-'))
		const p = spawn(process.execPath, ['--import', tsxImport, child, dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		p.stdout.on('data', d => {
			out += d
			if (signal && out.includes('READY')) setTimeout(() => p.kill(signal), 50)
		})
		p.stderr.on('data', d => (out += d))
		const t = setTimeout(() => (p.kill('SIGKILL'), reject(new Error('child hung: ' + out))), 10_000)
		p.on('exit', (code, sig) => (clearTimeout(t), resolve({ code, sig, dir, out })))
	})

const keyFile = (dir: string) => join(dir, 'main', 'pre-key-42.json')
const activity = (dir: string) => JSON.parse(readFileSync(join(dir, 'main', 'zenox-activity.json'), 'utf-8'))

describe('data survives the process dying (real child processes)', () => {
	it('SIGTERM: saves, marks a clean shutdown, exits 143', async () => {
		const r = await run('sigterm', 'SIGTERM')
		assert.equal(r.code, 143, r.out)
		assert.ok(existsSync(keyFile(r.dir)), 'pending key was flushed')
		assert.equal(activity(r.dir).shutdown.reason, 'SIGTERM')
	})

	it('SIGINT (Ctrl+C): saves and exits 130', async () => {
		const r = await run('sigterm', 'SIGINT')
		assert.equal(r.code, 130, r.out)
		assert.ok(existsSync(keyFile(r.dir)))
	})

	it('uncaught exception: saves, then still exits with 1 like Node would', async () => {
		const r = await run('throw')
		assert.equal(r.code, 1, r.out)
		assert.ok(existsSync(keyFile(r.dir)))
	})

	it('process.exit() in your own code: the sync exit hook saves', async () => {
		const r = await run('exit')
		assert.equal(r.code, 3)
		assert.ok(existsSync(keyFile(r.dir)))
		assert.equal(activity(r.dir).shutdown, undefined, 'not a clean shutdown, so next start reports a crash')
	})

	it('unhandled rejection: logged, saved, process keeps running by default (killed by us after)', async () => {
		const r = await run('reject', 'SIGTERM')
		assert.ok(r.out.includes('ALIVE_AFTER_REJECTION'), r.out)
		assert.equal(r.code, 143, r.out)
		assert.ok(existsSync(keyFile(r.dir)))
	})

	it('process ending naturally: beforeExit/exit saves', async () => {
		const r = await run('natural')
		assert.equal(r.code, 0, r.out)
		assert.ok(existsSync(keyFile(r.dir)))
	})
})
