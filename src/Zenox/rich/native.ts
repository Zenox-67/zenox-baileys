import type { proto } from '../../../WAProto/index.js'
import type { Block } from './markdown'
import { HIGHLIGHT_ENUM, tokenize } from './highlight'
import { latexToUnicode } from './latex'
import { inlineToWhatsApp } from './text'

/**
 * Builds `Message.richResponseMessage` (the structured answer layout WhatsApp uses for its own AI replies:
 * text, code with highlighting, tables, LaTeX). The field layout comes straight from WAProto.
 *
 * IMPORTANT: this only describes the message. Whether a normal (non-bot) account may send it, and which
 * app versions draw it, is decided by WhatsApp and has to be tested live. Use mode 'text' for a safe fallback.
 */

/** Same numbers as `AIRichResponseSubMessageType` / `AIRichResponseMessageType`. */
export const RICH_SUBMESSAGE = { text: 2, table: 4, code: 5, latex: 8 } as const
export const RICH_TYPE_STANDARD = 1

export interface LatexImage {
	/** where the rendered formula image can be fetched */
	url: string
	width: number
	height: number
}

export interface NativeRichOptions {
	/** turn a formula into a hosted image; without it, formulas are shown as Unicode text */
	latexImage?: (tex: string) => Promise<LatexImage | undefined> | LatexImage | undefined
}

type SubMessage = NonNullable<proto.IAIRichResponseMessage['submessages']>[number]

const textSub = (messageText: string): SubMessage => ({ messageType: RICH_SUBMESSAGE.text, messageText })

export async function blocksToRichResponse(blocks: Block[], opts: NativeRichOptions = {}): Promise<proto.IMessage> {
	const submessages: SubMessage[] = []
	// WhatsApp wants one text sub-message per paragraph-ish chunk; consecutive text blocks are merged
	let pending: string[] = []
	const flushText = () => {
		if (pending.length) submessages.push(textSub(pending.join('\n\n')))
		pending = []
	}

	for (const b of blocks) {
		switch (b.type) {
			case 'paragraph':
				pending.push(inlineToWhatsApp(b.text))
				break
			case 'heading':
				pending.push(`*${inlineToWhatsApp(b.text).replace(/^\*(.*)\*$/s, '$1')}*`)
				break
			case 'list':
				pending.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${inlineToWhatsApp(it)}`).join('\n'))
				break
			case 'quote':
				pending.push(b.text.split('\n').map(l => `> ${inlineToWhatsApp(l)}`).join('\n'))
				break
			case 'hr':
				pending.push('──────────')
				break
			case 'code':
				flushText()
				submessages.push({
					messageType: RICH_SUBMESSAGE.code,
					codeMetadata: {
						codeLanguage: b.lang || undefined,
						codeBlocks: tokenize(b.code, b.lang).map(t => ({
							highlightType: HIGHLIGHT_ENUM[t.type],
							codeContent: t.text
						}))
					}
				})
				break
			case 'table':
				flushText()
				submessages.push({
					messageType: RICH_SUBMESSAGE.table,
					tableMetadata: {
						rows: [
							{ items: b.header, isHeading: true },
							...b.rows.map(items => ({ items, isHeading: false }))
						]
					}
				})
				break
			case 'math': {
				flushText()
				const img = await opts.latexImage?.(b.tex)
				submessages.push({
					messageType: RICH_SUBMESSAGE.latex,
					latexMetadata: {
						text: latexToUnicode(b.tex), // what is shown where the image cannot be
						expressions: [
							{
								latexExpression: b.tex,
								...(img ? { url: img.url, width: img.width, height: img.height } : {})
							}
						]
					}
				})
				break
			}
		}
	}

	flushText()
	return {
		richResponseMessage: {
			messageType: RICH_TYPE_STANDARD,
			submessages
		}
	}
}
