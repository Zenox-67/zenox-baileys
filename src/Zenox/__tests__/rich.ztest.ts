import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { MemoryCache, TieredCache } from '../cache'
import { button, buildInteractive, extractButtonId } from '../rich/buttons'
import { tokenize } from '../rich/highlight'
import { latexToUnicode } from '../rich/latex'
import { parseMarkdown } from '../rich/markdown'
import { blocksToRichResponse } from '../rich/native'
import { splitText, ZenoxRich } from '../rich/rich'
import { blockToText, cellWidth, inlineToWhatsApp, tableToText } from '../rich/text'
import { wait } from './helpers'

const md = `# Judul

Ini **tebal**, *miring*, ~~coret~~ dan \`kode\` dengan [link](https://x.io).

- satu
- dua

1. a
2. b

> kutipan

| Nama | Nilai |
|:-----|------:|
| a | 1 |
| b | 22 |

\`\`\`js
const x = foo(1, "hi") // note
\`\`\`

$$
\\frac{a}{b} + x^2
$$
`

describe('rich: markdown parser', () => {
	it('reads every block type', () => {
		const types = parseMarkdown(md).map(b => b.type)
		assert.deepEqual(types, ['heading', 'paragraph', 'list', 'list', 'quote', 'table', 'code', 'math'])
	})

	it('table keeps header, rows and alignment; escaped pipes survive', () => {
		const t = parseMarkdown('| a | b |\n|:--|--:|\n| 1 \\| 2 | 3 |')[0] as any
		assert.deepEqual(t.header, ['a', 'b'])
		assert.deepEqual(t.rows, [['1 | 2', '3']])
		assert.deepEqual(t.align, ['left', 'right'])
	})

	it('code fences are not parsed as markdown inside, and a longer closing fence works', () => {
		const b = parseMarkdown('````\n```\n| a | b |\n|--|--|\n````') as any[]
		assert.equal(b.length, 1)
		assert.equal(b[0].type, 'code')
		assert.match(b[0].code, /\| a \| b \|/)
	})

	it('single-line $$ math and unterminated fences do not hang or throw', () => {
		assert.deepEqual(parseMarkdown('$$ x^2 $$'), [{ type: 'math', tex: 'x^2' }])
		assert.equal((parseMarkdown('```py\nprint(1)') as any[])[0].code, 'print(1)')
	})
})

describe('rich: WhatsApp text rendering', () => {
	it('inline formats: bold, italic (not confused with bold), strike, links, code spans untouched', () => {
		assert.equal(inlineToWhatsApp('**tebal** *miring* ~~coret~~'), '*tebal* _miring_ ~coret~')
		assert.equal(inlineToWhatsApp('***both***'), '*_both_*')
		assert.equal(inlineToWhatsApp('`**x**` dan **y**'), '`**x**` dan *y*')
		assert.equal(inlineToWhatsApp('[a](https://x.io)'), 'a (https://x.io)')
		assert.equal(inlineToWhatsApp('harga $5 dan $6'), 'harga $5 dan $6', 'prices are not math')
		assert.equal(inlineToWhatsApp('nilai $x^2$ ok'), 'nilai x² ok')
	})

	it('table: aligned monospace when it fits, cards when it is too wide', () => {
		const t = parseMarkdown('| Nama | Nilai |\n|:--|--:|\n| a | 1 |\n| bb | 22 |')[0] as any
		assert.equal(tableToText(t), '```\nNama │ Nilai\n─────┼──────\na    │     1\nbb   │    22\n```')
		const wide = parseMarkdown('| Produk | Deskripsi panjang sekali | Harga |\n|--|--|--|\n| Kopi | Biji arabika pilihan dari dataran tinggi | 25rb |')[0] as any
		const out = tableToText(wide, { maxWidth: 30 })
		assert.ok(!out.includes('```'))
		assert.match(out, /^\*Kopi\*\nDeskripsi panjang sekali: Biji/)
	})

	it('wide characters count double so columns still line up', () => {
		assert.equal(cellWidth('abc'), 3)
		assert.equal(cellWidth('日本'), 4)
	})

	it('code and math blocks become ``` blocks; headings become bold', () => {
		const blocks = parseMarkdown(md)
		assert.equal(blockToText(blocks[0]!), '*Judul*')
		assert.equal(blockToText(blocks[6]!), '```\nconst x = foo(1, "hi") // note\n```')
		assert.equal(blockToText(blocks[7]!), '```\na⁄b + x²\n```')
	})
})

describe('rich: LaTeX to Unicode', () => {
	it('common notation', () => {
		assert.equal(latexToUnicode('x^2 + y_1'), 'x² + y₁')
		assert.equal(latexToUnicode('\\alpha + \\beta \\leq \\infty'), 'α + β ≤ ∞')
		assert.equal(latexToUnicode('\\frac{a+b}{2}'), '(a+b)⁄2')
		assert.equal(latexToUnicode('\\sqrt{x^2+1}'), '√(x²+1)')
		assert.equal(latexToUnicode('\\sum_{i=1}^{n} i'), '∑ᵢ₌₁ⁿ i')
	})

	it('unknown commands are left alone instead of lost', () => {
		assert.match(latexToUnicode('\\weirdthing{1}'), /\\weirdthing/)
	})
})

describe('rich: code highlighting', () => {
	it('classifies keyword / method / string / number / comment', () => {
		const t = tokenize('const x = foo(1, "hi") // note', 'js')
		const kinds = Object.fromEntries(t.filter(x => x.type !== 'default').map(x => [x.text, x.type]))
		assert.deepEqual(kinds, { const: 'keyword', foo: 'method', '1': 'number', '"hi"': 'string', '// note': 'comment' })
		assert.equal(t.map(x => x.text).join(''), 'const x = foo(1, "hi") // note', 'tokens rebuild the source exactly')
	})

	it('# is a comment in python but not in js; lossless on odd input', () => {
		assert.equal(tokenize('x = 1 # c', 'python').at(-1)!.type, 'comment')
		assert.ok(!tokenize('a # b', 'js').some(t => t.type === 'comment'))
		const weird = 'a "unterminated\n/* open'
		assert.equal(tokenize(weird, 'js').map(t => t.text).join(''), weird)
	})
})

describe('rich: native rich response', () => {
	it('maps blocks to sub-messages with the proto numbers', async () => {
		const res: any = await blocksToRichResponse(parseMarkdown(md))
		const subs = res.richResponseMessage.submessages
		assert.equal(res.richResponseMessage.messageType, 1)
		assert.deepEqual(subs.map((s: any) => s.messageType), [2, 4, 5, 8])
		assert.match(subs[0].messageText, /^\*Judul\*/)
		assert.deepEqual(subs[1].tableMetadata.rows[0], { items: ['Nama', 'Nilai'], isHeading: true })
		assert.equal(subs[2].codeMetadata.codeLanguage, 'js')
		assert.equal(subs[2].codeMetadata.codeBlocks.map((b: any) => b.codeContent).join(''), 'const x = foo(1, "hi") // note')
		assert.equal(subs[3].latexMetadata.expressions[0].latexExpression, '\\frac{a}{b} + x^2')
	})

	it('uses the hosted formula image when one is provided', async () => {
		const res: any = await blocksToRichResponse([{ type: 'math', tex: 'x' }], { latexImage: () => ({ url: 'https://i/x.png', width: 10, height: 5 }) })
		assert.deepEqual(res.richResponseMessage.submessages[0].latexMetadata.expressions[0], { latexExpression: 'x', url: 'https://i/x.png', width: 10, height: 5 })
	})
})

describe('rich: buttons', () => {
	it('builds native flow buttons and the wrapped interactive message', () => {
		const b = button.quickReply('Ya', 'yes')
		assert.deepEqual(b, { name: 'quick_reply', buttonParamsJson: '{"display_text":"Ya","id":"yes"}' })
		const msg: any = buildInteractive({ body: 'Pilih', footer: 'f', buttons: [b, button.url('Buka', 'https://x.io'), button.copy('Salin', 'ABC')] })
		const im = msg.viewOnceMessage.message.interactiveMessage
		assert.equal(im.body.text, 'Pilih')
		assert.deepEqual(im.nativeFlowMessage.buttons.map((x: any) => x.name), ['quick_reply', 'cta_url', 'cta_copy'])
		assert.ok((buildInteractive({ body: 'x', buttons: [], wrap: false }) as any).interactiveMessage)
	})

	it('reads the tapped id from every reply format, also inside wrappers', () => {
		assert.equal(extractButtonId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"zx:more:abc"}' } } } as any), 'zx:more:abc')
		assert.equal(extractButtonId({ buttonsResponseMessage: { selectedButtonId: 'b1' } } as any), 'b1')
		assert.equal(extractButtonId({ listResponseMessage: { singleSelectReply: { selectedRowId: 'r1' } } } as any), 'r1')
		assert.equal(extractButtonId({ ephemeralMessage: { message: { templateButtonReplyMessage: { selectedId: 't1' } } } } as any), 't1')
		assert.equal(extractButtonId({ conversation: 'hai' } as any), undefined)
	})
})

/* ---------------------------------- engine ---------------------------------- */

class RichSock {
	ev = new EventEmitter() as any
	user = { id: '1@s.whatsapp.net' }
	texts: Array<{ jid: string; content: any }> = []
	relayed: Array<{ jid: string; message: any; opts: any }> = []
	async sendMessage(jid: string, content: any) {
		this.texts.push({ jid, content })
		return { key: { id: `t${this.texts.length}` }, message: { conversation: content.text } }
	}
	async relayMessage(jid: string, message: any, opts: any) {
		this.relayed.push({ jid, message, opts })
		return opts.messageId
	}
}

let idCounter = 0
const buildMessage = (_jid: string, content: any) => ({ key: { id: `m${++idCounter}`, fromMe: true }, message: content })
const makeRich = (options: any = {}) => {
	const sock = new RichSock()
	const store = new TieredCache(new MemoryCache())
	const rich = new ZenoxRich({ buildMessage, store, options }).attach(sock as any)
	return { sock, rich, store }
}
const tap = (sock: RichSock, jid: string, id: string) =>
	sock.ev.emit('messages.upsert', {
		type: 'notify',
		messages: [{ key: { remoteJid: jid, fromMe: false, id: 'x' }, message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) } } } }]
	})
const buttonId = (relayed: any) =>
	JSON.parse(relayed.message.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson).id as string

describe('rich: sending', () => {
	it('short answers go out as one plain message', async () => {
		const { sock, rich } = makeRich()
		await rich.send('a@s.whatsapp.net', '**halo** dunia')
		assert.deepEqual(sock.texts.map(t => t.content.text), ['*halo* dunia'])
		assert.equal(sock.relayed.length, 0)
	})

	it('long answers: first page + "Lihat selengkapnya" button, tapping it sends the next page, then no button', async () => {
		const { sock, rich } = makeRich({ maxChars: 100 })
		const jid = 'a@s.whatsapp.net'
		const paras = ['satu '.repeat(15).trim(), 'dua '.repeat(20).trim(), 'tiga '.repeat(10).trim()]
		await rich.send(jid, paras.join('\n\n'))

		assert.equal(sock.relayed.length, 1, 'first page carries the button')
		const first = sock.relayed[0]!.message.viewOnceMessage.message.interactiveMessage
		assert.equal(first.body.text, paras[0])
		assert.match(buttonId(sock.relayed[0]), /^zx:more:/)
		assert.equal(sock.relayed[0]!.opts.additionalNodes[0].tag, 'biz', 'native flow nodes are attached')

		tap(sock, jid, buttonId(sock.relayed[0]))
		await wait(20)
		assert.equal(sock.relayed.length, 2, 'second page also has a button (one more page left)')
		assert.equal(sock.relayed[1]!.message.viewOnceMessage.message.interactiveMessage.body.text, paras[1])

		tap(sock, jid, buttonId(sock.relayed[1]))
		await wait(20)
		assert.equal(sock.texts.at(-1)!.content.text, paras[2], 'last page is plain text without a button')
		assert.equal(sock.relayed.length, 2)
	})

	it('a double tap or a tap from another chat sends nothing twice', async () => {
		const { sock, rich } = makeRich({ maxChars: 50 })
		await rich.send('a@s.whatsapp.net', 'x '.repeat(40) + '\n\n' + 'y '.repeat(40))
		const id = buttonId(sock.relayed[0])
		tap(sock, 'other@s.whatsapp.net', id)
		await wait(20)
		assert.equal(sock.texts.length + sock.relayed.length, 1, 'wrong chat ignored')
		tap(sock, 'a@s.whatsapp.net', id)
		tap(sock, 'a@s.whatsapp.net', id)
		await wait(30)
		assert.equal(sock.texts.length + sock.relayed.length, 2, 'only one continuation')
	})

	it('"see more" state lives in the store, so it works after a restart (new ZenoxRich, same store)', async () => {
		const store = new TieredCache(new MemoryCache())
		const s1 = new RichSock()
		const r1 = new ZenoxRich({ buildMessage, store, options: { maxChars: 50 } }).attach(s1 as any)
		await r1.send('a@s.whatsapp.net', 'x '.repeat(40) + '\n\n' + 'tail')
		const id = buttonId(s1.relayed[0])

		const s2 = new RichSock()
		new ZenoxRich({ buildMessage, store, options: { maxChars: 50 } }).attach(s2 as any)
		tap(s2, 'a@s.whatsapp.net', id)
		await wait(20)
		assert.ok(s2.texts.at(-1)!.content.text.endsWith('tail'), 'the saved rest is sent after the restart')
	})

	it('moreCommand works for clients that do not draw buttons', async () => {
		const { sock, rich } = makeRich({ maxChars: 50, moreCommand: '.more' })
		await rich.send('a@s.whatsapp.net', 'x '.repeat(40) + '\n\n' + 'tail')
		assert.match(sock.relayed[0]!.message.viewOnceMessage.message.interactiveMessage.body.text, /ketik \.more/)
		sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'y' }, message: { conversation: '.MORE ' } }] })
		await wait(20)
		assert.ok(sock.texts.at(-1)!.content.text.endsWith('tail'))
	})

	it('code and tables are never cut in the middle', async () => {
		const { sock, rich } = makeRich({ maxChars: 30 })
		const code = '```js\n' + 'const aVeryLongLine = 1\n'.repeat(5) + '```'
		await rich.send('a@s.whatsapp.net', 'intro\n\n' + code)
		const bodies = [...sock.texts.map(t => t.content.text), ...sock.relayed.map(r => r.message.viewOnceMessage.message.interactiveMessage.body.text)]
		assert.ok(bodies.some(b => b.startsWith('```\nconst aVeryLongLine') && b.endsWith('```') && b.split('const aVeryLongLine').length === 6) || sock.relayed.length > 0)
	})

	it('seeMore:false sends everything now', async () => {
		const { sock, rich } = makeRich({ maxChars: 20 })
		await rich.send('a@s.whatsapp.net', 'a '.repeat(30) + '\n\n' + 'b '.repeat(30), { seeMore: false })
		assert.equal(sock.relayed.length, 0)
		assert.equal(sock.texts.length, 1)
	})

	it('formulas become images when a renderer is given, text when it fails', async () => {
		const ok = makeRich({ latexImage: async () => ({ buffer: Buffer.from('png') }) })
		await ok.rich.send('a@s.whatsapp.net', 'antara\n\n$$x^2$$\n\nsesudah')
		assert.deepEqual(ok.sock.texts.map(t => (t.content.image ? 'image' : t.content.text)), ['antara', 'image', 'sesudah'])

		const bad = makeRich({ latexImage: async () => { throw new Error('boom') } })
		await bad.rich.send('a@s.whatsapp.net', '$$x^2$$')
		assert.equal(bad.sock.texts[0]!.content.text, '```\nx²\n```')
	})

	it('native mode relays a richResponseMessage (no text messages)', async () => {
		const { sock, rich } = makeRich({ mode: 'native' })
		await rich.send('a@s.whatsapp.net', 'hai\n\n```py\nprint(1)\n```')
		assert.equal(sock.texts.length, 0)
		assert.equal(sock.relayed[0]!.message.richResponseMessage.submessages.length, 2)
	})

	it('sent rich messages are announced on messages.upsert so the sent-message store can keep them', async () => {
		const { sock, rich } = makeRich({ mode: 'native' })
		const seen: any[] = []
		sock.ev.on('messages.upsert', (u: any) => u.messages.forEach((m: any) => m.key.fromMe && seen.push(m.key.id)))
		await rich.send('a@s.whatsapp.net', 'hai')
		assert.equal(seen.length, 1)
	})
})

describe('rich: action buttons', () => {
	it('a tap runs the registered handler with its data, also for a fresh instance sharing the store', async () => {
		const { sock, rich, store } = makeRich()
		const got: any[] = []
		rich.onAction('confirm', ctx => void got.push(ctx.data))
		const b = await rich.action('Setuju', 'confirm', { order: 7 })
		await rich.sendButtons('a@s.whatsapp.net', { body: 'Lanjut?', buttons: [b] })
		tap(sock, 'a@s.whatsapp.net', buttonId(sock.relayed[0]))
		await wait(20)
		assert.deepEqual(got, [{ order: 7 }])

		const sock2 = new RichSock()
		const rich2 = new ZenoxRich({ buildMessage, store }).attach(sock2 as any)
		rich2.onAction('confirm', ctx => void got.push(ctx.data))
		tap(sock2, 'a@s.whatsapp.net', buttonId(sock.relayed[0]))
		await wait(20)
		assert.equal(got.length, 2)
	})

	it('unknown or expired buttons are swallowed quietly; foreign ids are not ours', async () => {
		const { sock, rich } = makeRich()
		assert.equal(await rich.handle({ key: { remoteJid: 'a@s.whatsapp.net' }, message: { buttonsResponseMessage: { selectedButtonId: 'zx:a:nope:zzz' } } }), true)
		assert.equal(await rich.handle({ key: { remoteJid: 'a@s.whatsapp.net' }, message: { buttonsResponseMessage: { selectedButtonId: 'menu:1' } } }), false)
		assert.equal(sock.texts.length + sock.relayed.length, 0)
	})
})

describe('rich: splitText', () => {
	it('cuts at boundaries and never exceeds the limit', () => {
		const parts = splitText('aaa bbb ccc ddd eee fff', 8)
		assert.ok(parts.every(p => p.length <= 8))
		assert.equal(parts.join(' '), 'aaa bbb ccc ddd eee fff')
		assert.deepEqual(splitText('short', 100), ['short'])
		assert.equal(splitText('x'.repeat(25), 10).join(''), 'x'.repeat(25))
	})
})
