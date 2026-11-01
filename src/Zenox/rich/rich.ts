import { randomBytes } from 'crypto'
import type { proto } from '../../../WAProto/index.js'
import { buildInteractive, button, extractButtonId, nativeFlowNodes, type NativeButton } from './buttons'
import { parseMarkdown, type Block } from './markdown'
import { blocksToRichResponse, type NativeRichOptions } from './native'
import { blockToText, type RenderTextOptions } from './text'
import { latexToUnicode } from './latex'
import { silentLogger, type ZenoxLogger } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 'text' = classic WhatsApp formatting, works everywhere. 'native' = rich response layout (needs live testing). */
export type RichMode = 'text' | 'native'

/** What the rich layer needs from a Baileys socket (structural, so it is easy to test). */
export interface RichSocketLike {
	user?: { id: string } | undefined
	ev: { on(event: any, listener: (...args: any[]) => void): void; emit?: (event: any, data: any) => unknown }
	sendMessage(jid: string, content: any, options?: any): Promise<any>
	relayMessage(jid: string, message: proto.IMessage, options: { messageId?: string; additionalNodes?: any[] }): Promise<string>
}

/** Subset of Baileys' `CacheStore`; `TieredCache` (memory + redis) fits. */
export interface RichStore {
	get<T>(key: string): Promise<T | undefined> | T | undefined
	set<T>(key: string, value: T, ttlMs?: number): unknown
	del(key: string): unknown
}

export interface RichOptions {
	/** default 'text' */
	mode?: RichMode
	/** a message longer than this gets a "Lihat selengkapnya" button (default 1500, 0 = never split) */
	maxChars?: number
	/** button label (default "Lihat selengkapnya") */
	seeMoreLabel?: string
	/** also accept this text command (e.g. ".more") for clients that do not draw buttons; shown as a hint */
	moreCommand?: string
	/** how long the unread rest and action payloads are kept (default 24h) */
	stateTtlMs?: number
	/** text mode: render a formula as an image (PNG/JPEG buffer). Return undefined to fall back to Unicode text. */
	latexImage?: (tex: string) => Promise<{ buffer: Buffer; mimetype?: string } | undefined> | { buffer: Buffer; mimetype?: string } | undefined
	/** native mode: turn a formula into a hosted image */
	nativeLatexImage?: NativeRichOptions['latexImage']
	tableMaxWidth?: number
	math?: RenderTextOptions['math']
	/** send the `<biz>` stanza nodes that native-flow buttons need (default true) */
	nativeFlowNodes?: boolean
}

export interface RichDeps {
	/** Baileys' `generateWAMessageFromContent` */
	buildMessage: (jid: string, content: proto.IMessage, options: { userJid: string; quoted?: any }) => any
	store: RichStore
	/** uploads a picture for the header of a button message and returns its `imageMessage` (needed for `sendButtons({ image })`) */
	prepareImage?: (sock: RichSocketLike, jid: string, image: Buffer | { url: string }) => Promise<proto.Message.IImageMessage>
	options?: RichOptions
	logger?: ZenoxLogger
}

export interface SendRichOptions {
	mode?: RichMode
	quoted?: any
	/** `false` sends everything at once; an object overrides `maxChars` for this call */
	seeMore?: boolean | { maxChars?: number }
}

export interface ActionContext {
	jid: string
	data: unknown
	/** the message that carried the tap */
	message: any
	rich: ZenoxRich
}

export type ActionHandler = (ctx: ActionContext) => void | Promise<void>

/** One unit of an answer: a piece of text, or a formula that may become an image. */
type Segment = { k: 't'; v: string } | { k: 'm'; v: string }

interface MoreState {
	jid: string
	rest: Segment[]
}

const HARD_LIMIT = 20_000
const token = () => randomBytes(6).toString('base64url')

/** Split a long text at line / sentence / word boundaries into pieces of at most `max` characters. */
export function splitText(text: string, max: number): string[] {
	if (max <= 0 || text.length <= max) return [text]
	const out: string[] = []
	let rest = text
	while (rest.length > max) {
		const window = rest.slice(0, max)
		let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1, window.lastIndexOf(' '))
		if (cut < max * 0.4) cut = max // no good boundary: hard cut
		out.push(rest.slice(0, cut).trimEnd())
		rest = rest.slice(cut).trimStart()
	}

	if (rest) out.push(rest)
	return out
}

export class ZenoxRich {
	private sock?: RichSocketLike
	private readonly actions = new Map<string, ActionHandler>()
	private readonly claimed = new Set<string>()
	private readonly log: ZenoxLogger
	private readonly opt: Required<Pick<RichOptions, 'mode' | 'maxChars' | 'seeMoreLabel' | 'stateTtlMs'>> & RichOptions

	constructor(private readonly deps: RichDeps) {
		this.log = deps.logger ?? silentLogger
		const o = deps.options ?? {}
		this.opt = {
			...o,
			mode: o.mode ?? 'text',
			maxChars: o.maxChars ?? 1500,
			seeMoreLabel: o.seeMoreLabel ?? 'Lihat selengkapnya',
			stateTtlMs: o.stateTtlMs ?? 24 * 60 * 60_000
		}
	}

	/** Point this rich layer at a (new) socket. The manager calls it after every reconnect; handlers and state survive. */
	attach(sock: RichSocketLike): this {
		this.sock = sock
		sock.ev.on('messages.upsert', (u: any) => {
			for (const m of u?.messages ?? []) {
				if (m?.key?.fromMe || !m?.message) continue
				void this.handle(m).catch(err => this.log.error({ err }, 'zenox: rich interaction failed'))
			}
		})
		return this
	}

	private get s(): RichSocketLike {
		if (!this.sock) throw new Error('zenox rich: no socket attached yet')
		return this.sock
	}

	/* ------------------------------- buttons -------------------------------- */

	/** native-flow button builders: quickReply, url, copy, call, location, select, custom */
	readonly button = button

	/** Register what happens when someone taps an `action()` button. Registering the same name again replaces it. */
	onAction(name: string, handler: ActionHandler): this {
		this.actions.set(name, handler)
		return this
	}

	/**
	 * An app-level button: a quick reply whose tap runs your `onAction(name)` handler with `data`.
	 * `data` is kept in the cache/redis, so the button still works after a restart.
	 */
	async action(label: string, name: string, data?: unknown): Promise<NativeButton> {
		const t = token()
		await this.deps.store.set(`act:${t}`, { name, data }, this.opt.stateTtlMs)
		return button.quickReply(label, `zx:a:${name}:${t}`)
	}

	/** Send a message with native-flow buttons. */
	async sendButtons(
		jid: string,
		input: {
			body: string
			footer?: string
			title?: string
			buttons: NativeButton[]
			wrap?: boolean
			/** a picture above the text, e.g. `await starPng()`; needs WhatsApp to accept an image header on native-flow messages (unverified on every client) */
			image?: Buffer | { url: string }
		},
		opts: { quoted?: any } = {}
	) {
		const { image, ...rest } = input
		let imageMessage: proto.Message.IImageMessage | undefined
		if (image) {
			if (!this.deps.prepareImage) throw new Error('zenox rich: this setup cannot upload a header image (no prepareImage)')
			imageMessage = await this.deps.prepareImage(this.s, jid, image)
		}

		const content = buildInteractive({ ...rest, ...(imageMessage ? { image: imageMessage } : {}) })
		const isPrivate = !jid.endsWith('@g.us') && !jid.endsWith('@newsletter')
		return this.relay(jid, content, opts.quoted, this.opt.nativeFlowNodes === false ? undefined : nativeFlowNodes(isPrivate))
	}

	/* --------------------------------- send --------------------------------- */

	/** Render markdown (code, tables, math, bold, lists ...) and send it. */
	async send(jid: string, input: string | Block[], opts: SendRichOptions = {}): Promise<any[]> {
		const blocks = typeof input === 'string' ? parseMarkdown(input) : input
		const mode = opts.mode ?? this.opt.mode

		if (mode === 'native') {
			const content = await blocksToRichResponse(blocks, { latexImage: this.opt.nativeLatexImage })
			return [await this.relay(jid, content, opts.quoted)]
		}

		const segments = this.toSegments(blocks)
		const seeMore = opts.seeMore === false ? false : true
		const maxChars = typeof opts.seeMore === 'object' && opts.seeMore.maxChars !== undefined ? opts.seeMore.maxChars : this.opt.maxChars
		return this.sendSegments(jid, segments, { quoted: opts.quoted, limit: seeMore && maxChars > 0 ? maxChars : HARD_LIMIT, button: seeMore && maxChars > 0 })
	}

	private toSegments(blocks: Block[]): Segment[] {
		const textOpts: RenderTextOptions = { math: this.opt.math, maxWidth: this.opt.tableMaxWidth }
		const out: Segment[] = []
		for (const b of blocks) {
			if (b.type === 'math' && this.opt.latexImage) out.push({ k: 'm', v: b.tex })
			else for (const piece of splitText(blockToText(b, textOpts), b.type === 'code' || b.type === 'table' || b.type === 'math' ? Infinity : HARD_LIMIT)) out.push({ k: 't', v: piece })
		}

		return out
	}

	/** Take as many segments as fit into one page. */
	private takePage(segments: Segment[], limit: number): { page: Segment[]; rest: Segment[] } {
		const page: Segment[] = []
		let used = 0
		let i = 0
		for (; i < segments.length; i++) {
			const seg = segments[i]!
			if (seg.k === 'm') {
				page.push(seg)
				continue
			}

			let piece = seg
			if (!page.some(p => p.k === 't') && seg.v.length > limit && !seg.v.startsWith('```')) {
				// a single long paragraph/list: cut it, the remainder goes back to the front of the queue
				const [head, ...tail] = splitText(seg.v, limit)
				piece = { k: 't', v: head! }
				if (tail.length) segments = [...segments.slice(0, i), piece, { k: 't', v: tail.join('\n') }, ...segments.slice(i + 1)]
			}

			const cost = piece.v.length + (used ? 2 : 0)
			if (used && used + cost > limit) break
			page.push(piece)
			used += cost
		}

		return { page, rest: segments.slice(i) }
	}

	private async sendSegments(jid: string, segments: Segment[], o: { quoted?: any; limit: number; button: boolean }): Promise<any[]> {
		const sent: any[] = []
		let queue = segments
		let first = true
		while (queue.length) {
			const { page, rest } = this.takePage(queue, o.limit)
			queue = rest
			const more = queue.length > 0 && o.button
			let buffer: string[] = []

			const flushText = async (withButton: boolean) => {
				const text = buffer.join('\n\n')
				buffer = []
				if (!text) return
				if (withButton) sent.push(await this.sendMoreButton(jid, text, queue, first ? o.quoted : undefined))
				else sent.push(await this.s.sendMessage(jid, { text }, first && o.quoted ? { quoted: o.quoted } : undefined))
				first = false
			}

			for (let i = 0; i < page.length; i++) {
				const seg = page[i]!
				if (seg.k === 't') {
					buffer.push(seg.v)
					continue
				}

				await flushText(false)
				sent.push(await this.sendFormula(jid, seg.v, first ? o.quoted : undefined))
				first = false
			}

			if (more) {
				if (buffer.length) await flushText(true)
				else sent.push(await this.sendMoreButton(jid, `${this.opt.seeMoreLabel} ⬇️`, queue, undefined))
				break
			}

			await flushText(false)
		}

		return sent
	}

	private async sendFormula(jid: string, tex: string, quoted?: any) {
		try {
			const img = await this.opt.latexImage?.(tex)
			if (img) return await this.s.sendMessage(jid, { image: img.buffer, mimetype: img.mimetype ?? 'image/png', caption: '' }, quoted ? { quoted } : undefined)
		} catch (err) {
			this.log.warn({ err }, 'zenox: formula image failed, sending text instead')
		}

		return this.s.sendMessage(jid, { text: '```\n' + latexToUnicode(tex) + '\n```' }, quoted ? { quoted } : undefined)
	}

	private async sendMoreButton(jid: string, body: string, rest: Segment[], quoted?: any) {
		const t = token()
		await this.deps.store.set<MoreState>(`more:${t}`, { jid, rest }, this.opt.stateTtlMs)
		if (this.opt.moreCommand) await this.deps.store.set(`last:${jid}`, t, this.opt.stateTtlMs)
		const hint = this.opt.moreCommand ? `\n\n_Atau ketik ${this.opt.moreCommand}_` : ''
		return this.sendButtons(jid, { body: body + hint, buttons: [button.quickReply(this.opt.seeMoreLabel, `zx:more:${t}`)] }, { quoted })
	}

	/* ------------------------------ interactions ----------------------------- */

	/** Handle a tap on a Zenox button (or the "more" text command). Returns true when the message was ours. */
	async handle(msg: any): Promise<boolean> {
		const jid: string | undefined = msg?.key?.remoteJid
		if (!jid) return false

		const cmd = this.opt.moreCommand?.toLowerCase()
		if (cmd) {
			const text = (msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '').trim().toLowerCase()
			if (text === cmd) {
				const t = await this.deps.store.get<string>(`last:${jid}`)
				if (t) return this.continueMore(jid, t)
			}
		}

		const id = extractButtonId(msg.message)
		if (!id?.startsWith('zx:')) return false

		const [, kind, ...rest] = id.split(':')
		if (kind === 'more') return this.continueMore(jid, rest.join(':'))
		if (kind === 'a') {
			const t = rest.pop()!
			const state = await this.deps.store.get<{ name: string; data: unknown }>(`act:${t}`)
			if (!state) return true // expired: swallow the tap, it was ours
			const handler = this.actions.get(state.name)
			if (!handler) {
				this.log.warn({ action: state.name }, 'zenox: button tapped but no onAction handler is registered')
				return true
			}

			await handler({ jid, data: state.data, message: msg, rich: this })
			return true
		}

		return false
	}

	private async continueMore(jid: string, t: string): Promise<boolean> {
		// claim synchronously: two quick taps would otherwise both read the state before either deletes it
		if (this.claimed.has(t)) return true
		this.claimed.add(t)
		try {
			const state = await this.deps.store.get<MoreState>(`more:${t}`)
			if (!state || state.jid !== jid) return true // expired, used already, or someone else's chat
			await this.deps.store.del(`more:${t}`) // one use
			await this.sendSegments(jid, state.rest, { limit: this.opt.maxChars > 0 ? this.opt.maxChars : HARD_LIMIT, button: this.opt.maxChars > 0 })
		} finally {
			this.claimed.delete(t)
		}

		return true
	}

	/* ------------------------------ low level -------------------------------- */

	private async relay(jid: string, content: proto.IMessage, quoted?: any, additionalNodes?: any[]) {
		const sock = this.s
		const userJid = sock.user?.id
		if (!userJid) throw new Error('zenox rich: the socket is not logged in yet')
		const full = this.deps.buildMessage(jid, content, { userJid, quoted })
		await sock.relayMessage(jid, full.message, { messageId: full.key.id, additionalNodes })
		// like sendMessage(): let the rest of the app (and Zenox' sent-message store) see our own message
		sock.ev.emit?.('messages.upsert', { messages: [full], type: 'append' })
		return full
	}
}
