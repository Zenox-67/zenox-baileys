import type { proto } from '../../../WAProto/index.js'
import { STAR_GLYPH } from './icons'

/**
 * Native-flow buttons (`Message.interactiveMessage.nativeFlowMessage`).
 * The button NAMES below are the ones WhatsApp clients are known to draw; the client decides what it
 * understands, so a brand-new type cannot be invented from the bot side. `custom()` lets you try any name.
 */

export interface NativeButton {
	name: string
	buttonParamsJson: string
}

const btn = (name: string, params: Record<string, unknown>): NativeButton => ({ name, buttonParamsJson: JSON.stringify(params) })

export const button = {
	/** a tap sends back `id` (read it with `extractButtonId`) */
	quickReply: (text: string, id: string) => btn('quick_reply', { display_text: text, id }),
	/**
	 * Quick reply with a star glyph (U+2605, text, not an emoji) in front of the label.
	 * WhatsApp draws the little icon of a button itself; this is the way to get a star in the button.
	 */
	star: (text: string, id: string) => btn('quick_reply', { display_text: `${STAR_GLYPH} ${text}`, id }),
	url: (text: string, url: string) => btn('cta_url', { display_text: text, url, merchant_url: url }),
	/** copies `code` to the clipboard */
	copy: (text: string, code: string) => btn('cta_copy', { display_text: text, copy_code: code }),
	call: (text: string, phone: string) => btn('cta_call', { display_text: text, phone_number: phone }),
	location: (text = 'Kirim lokasi') => btn('send_location', { display_text: text }),
	/** a drop-down list; every row sends back its `id` */
	select: (
		title: string,
		sections: Array<{ title: string; rows: Array<{ title: string; description?: string; id: string }>; highlightLabel?: string }>
	) =>
		btn('single_select', {
			title,
			sections: sections.map(s => ({
				title: s.title,
				highlight_label: s.highlightLabel,
				rows: s.rows.map(r => ({ title: r.title, description: r.description ?? '', id: r.id }))
			}))
		}),
	/** any other button name WhatsApp may understand: experiment freely */
	custom: btn
}

export interface InteractiveInput {
	body: string
	footer?: string
	title?: string
	/** picture shown above the text (an already uploaded `imageMessage`, see `ZenoxRich.sendButtons({ image })`) */
	image?: proto.Message.IImageMessage
	buttons: NativeButton[]
	/** wrap in `viewOnceMessage` with `messageContextInfo`, which most clients need to draw native-flow buttons (default true) */
	wrap?: boolean
}

export function buildInteractive(input: InteractiveInput): proto.IMessage {
	const interactiveMessage: proto.Message.IInteractiveMessage = {
		body: { text: input.body },
		...(input.footer ? { footer: { text: input.footer } } : {}),
		...(input.image
			? { header: { ...(input.title ? { title: input.title } : {}), hasMediaAttachment: true, imageMessage: input.image } }
			: input.title
				? { header: { title: input.title, hasMediaAttachment: false } }
				: {}),
		nativeFlowMessage: { buttons: input.buttons, messageParamsJson: '' }
	}

	if (input.wrap === false) return { interactiveMessage }
	return {
		viewOnceMessage: {
			message: {
				messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
				interactiveMessage
			}
		}
	}
}

/**
 * Extra stanza nodes that ask WhatsApp to treat the message as native flow (needed by many clients to draw
 * the buttons). Taken from how the community forks send them; unverified against every WhatsApp version.
 */
export const nativeFlowNodes = (isPrivateChat: boolean) => [
	{
		tag: 'biz',
		attrs: {},
		content: [
			{
				tag: 'interactive',
				attrs: { type: 'native_flow', v: '1' },
				content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
			}
		]
	},
	...(isPrivateChat ? [{ tag: 'bot', attrs: { biz_bot: '1' } }] : [])
]

/* eslint-disable @typescript-eslint/no-explicit-any */
const unwrap = (m: any): any => {
	let cur = m
	for (let i = 0; i < 6 && cur; i++) {
		const next = cur.ephemeralMessage?.message ?? cur.viewOnceMessage?.message ?? cur.viewOnceMessageV2?.message ?? cur.documentWithCaptionMessage?.message
		if (!next) break
		cur = next
	}

	return cur
}

/** The id of whatever button / list row the user tapped, from any of the reply formats (or undefined). */
export function extractButtonId(message: proto.IMessage | null | undefined): string | undefined {
	const m = unwrap(message)
	if (!m) return undefined
	const flow = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
	if (flow) {
		try {
			const parsed = JSON.parse(flow)
			if (typeof parsed?.id === 'string') return parsed.id
		} catch {
			// fall through
		}
	}

	return (
		m.buttonsResponseMessage?.selectedButtonId ||
		m.templateButtonReplyMessage?.selectedId ||
		m.listResponseMessage?.singleSelectReply?.selectedRowId ||
		undefined
	)
}
