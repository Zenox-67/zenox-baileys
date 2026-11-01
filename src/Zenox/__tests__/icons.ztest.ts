import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { buildInteractive, button } from '../rich/buttons'
import { STAR_GLYPH, starPng, starSvg, svgToPng } from '../rich/icons'
import { ZenoxRich } from '../rich/rich'

const loadSharp = () => {
	for (const base of ['/home/claude/.npm-global/lib/node_modules/', process.cwd() + '/node_modules/']) {
		try {
			const mod = createRequire(base)('sharp')
			return mod.default ?? mod
		} catch {
			// try the next place
		}
	}

	return undefined
}

describe('star icon (no emoji)', () => {
	it('the glyph is the text star, never the emoji star', () => {
		assert.equal(STAR_GLYPH.codePointAt(0), 0x2605)
		assert.ok(STAR_GLYPH.includes('︎'))
		assert.ok(!STAR_GLYPH.includes('⭐'))
	})

	it('button.star is a quick reply with the glyph in the label', () => {
		const b = button.star('Favorit', 'fav:1')
		assert.equal(b.name, 'quick_reply')
		assert.deepEqual(JSON.parse(b.buttonParamsJson), { display_text: `${STAR_GLYPH} Favorit`, id: 'fav:1' })
		assert.ok(!b.buttonParamsJson.includes('⭐'))
	})

	it('starSvg is a well-formed svg with a 5-point polygon and honours color/size', () => {
		const svg = starSvg({ color: '#ff0000', size: 64, background: '#000' })
		assert.match(svg, /^<svg [^>]*width="64" height="64"/)
		assert.match(svg, /fill="#ff0000"/)
		assert.equal(svg.match(/points="([^"]+)"/)![1]!.trim().split(/\s+/).length, 10)
		assert.ok(svg.endsWith('</svg>'))
		assert.ok(!starSvg().includes('<rect'))
	})

	it('draws the svg to a real PNG when sharp is available', async t => {
		const sharp = loadSharp()
		if (!sharp) return t.skip('sharp is not installed here')
		const png = await starPng({ size: 96, sharp })
		assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const meta = await sharp(png).metadata()
		assert.equal(meta.width, 96)
		assert.equal(meta.height, 96)
		// transparent corner, gold centre
		const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
		assert.equal(data[3], 0)
		const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4
		assert.ok(data[mid]! > 200 && data[mid + 3]! === 255)
	})

	it('svgToPng explains what is missing when sharp cannot be loaded', async () => {
		await assert.rejects(svgToPng('<svg/>', { sharp: 'nope' as never }), /sharp/)
	})
})

describe('buttons with a picture', () => {
	const image = { url: '/v/x', directPath: '/v/x', mediaKey: new Uint8Array([1]) }

	it('puts the image in the header', () => {
		const m = buildInteractive({ body: 'hai', buttons: [button.star('Suka', 'a')], image })
		const header = m.viewOnceMessage!.message!.interactiveMessage!.header!
		assert.equal(header.hasMediaAttachment, true)
		assert.equal(header.imageMessage, image)
	})

	it('keeps the old text-only header when there is no image', () => {
		const m = buildInteractive({ body: 'hai', title: 'T', buttons: [] })
		assert.deepEqual(m.viewOnceMessage!.message!.interactiveMessage!.header, { title: 'T', hasMediaAttachment: false })
	})

	it('sendButtons uploads the image through prepareImage and sends the header', async () => {
		let relayed: any
		const sock: any = {
			user: { id: '1@s.whatsapp.net' },
			ev: { on() {} },
			sendMessage: async () => ({}),
			relayMessage: async (_j: string, msg: any) => {
				relayed = msg
				return 'ID1'
			}
		}
		const rich = new ZenoxRich({
			buildMessage: (_jid, content) => ({ key: { id: 'X', remoteJid: 'a' }, message: content }) as never,
			store: { get: () => undefined, set: () => {}, del: () => {} },
			prepareImage: async () => image as never
		})
		rich.attach(sock)
		await rich.sendButtons('a@s.whatsapp.net', { body: 'b', image: Buffer.from('png'), buttons: [button.star('Suka', 'a')] })
		const content = relayed.viewOnceMessage?.message?.interactiveMessage ?? relayed.interactiveMessage
		assert.equal(content.header.imageMessage, image)
		await assert.rejects(
			new ZenoxRich({ buildMessage: (() => ({})) as never, store: { get: () => undefined, set: () => {}, del: () => {} } })
				.attach(sock)
				.sendButtons('a@s.whatsapp.net', { body: 'b', image: Buffer.from('png'), buttons: [] }),
			/prepareImage/
		)
	})
})
