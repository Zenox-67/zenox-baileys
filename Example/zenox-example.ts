/**
 * Zenox example: multi-session + Redis + auto reconnect + auto save.
 *
 *   REDIS_URL=rediss://default:xxxx@your-host:6379 PHONE=62812xxxxxxx npx tsx Example/zenox-example.ts
 *
 * Redis is optional: without REDIS_URL sessions live in ./zenox-sessions only.
 */
import P from 'pino'
import { createZenox } from '../src'

const logger = P({ level: 'warn' })

const zenox = await createZenox({
	sessionDir: './zenox-sessions',
	redis: process.env.REDIS_URL, // undefined = file only
	fetchLatestVersion: true,
	logger
})

// Runs for EVERY socket of EVERY session, and again after each auto-reconnect.
zenox.onSocket((sock, { session }) => {
	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') return
		for (const m of messages) {
			const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
			if (m.key.fromMe || !text || !m.key.remoteJid) continue
			zenox.setMeta(session, { lastCommand: text.slice(0, 50) }) // survives restarts
			if (text === '.ping') await sock.sendMessage(m.key.remoteJid, { text: 'pong' }, { quoted: m })

			// rich messages: markdown -> WhatsApp (bold, code block, table, math). Long answers get a
			// "Lihat selengkapnya" button, its state lives in redis so it still works after a restart.
			if (text === '.rich') {
				await sock.rich.send(
					m.key.remoteJid,
					[
						'# Demo',
						'Ini **tebal**, *miring*, ~~coret~~ dan `kode`.',
						'| Nama | Nilai |\n|:--|--:|\n| a | 1 |\n| bb | 22 |',
						'```js\nconst x = hitung(1, "hi") // contoh\n```',
						'$$\\frac{a+b}{2} + x^2$$'
					].join('\n\n'),
					{ quoted: m } // add `mode: 'native'` to try WhatsApp's own rich-response layout (test it live first)
				)
			}

			// your own buttons: the tap runs the handler, `data` is kept in redis
			if (text === '.tombol') {
				await sock.rich.sendButtons(m.key.remoteJid, {
					body: 'Lanjut?',
					buttons: [await sock.rich.action('Ya', 'konfirmasi', { pilihan: 'ya' }), sock.rich.button.url('Buka situs', 'https://example.com')]
				})
			}
		}
	})
})

zenox.onSocket(sock => {
	sock.rich.onAction('konfirmasi', async ({ jid, data }) => {
		await sock.sendMessage(jid, { text: `Kamu memilih: ${(data as { pilihan: string }).pilihan}` })
	})
})

zenox.on('qr', ({ session, qr }) => console.log(`[${session}] scan this QR:\n${qr}`))
zenox.on('pairing-code', ({ session, code }) => console.log(`[${session}] pairing code: ${code}`))
zenox.on('open', ({ session, reconnected }) => console.log(`[${session}] connected${reconnected ? ' (reconnected)' : ''}`))
zenox.on('reconnecting', e => console.log(`[${e.session}] reconnecting #${e.attempt} in ${e.delayMs}ms (code ${e.code})`))
zenox.on('offline', ({ session }) => console.log(`[${session}] no internet, waiting for it to come back`))
zenox.on('online', ({ session, offlineMs }) => console.log(`[${session}] internet is back after ${Math.round(offlineMs / 1000)}s, reconnecting`))
zenox.on('logged-out', ({ session }) => console.log(`[${session}] logged out, session removed. Start it again to re-pair.`))
zenox.on('restored', ({ session, previous, crashed }) => {
	if (previous) console.log(`[${session}] last seen ${new Date(previous.lastMessageAt ?? previous.startedAt).toISOString()}${crashed ? ' (previous run crashed)' : ''}`)
})

// 1) bring back every saved session (also restores from Redis on a fresh/wiped disk)
const started = await zenox.startAll()

// 2) first run: create one session and pair it
if (!started.length) await zenox.start('main', { pairingPhone: process.env.PHONE })

// Ctrl+C / SIGTERM / crash are handled for you: everything is saved before exit.
