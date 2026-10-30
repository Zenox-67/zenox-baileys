import type { Block } from './markdown'
import { latexToUnicode } from './latex'

/** WhatsApp's own formatting: *bold* _italic_ ~strike~ `mono` ```block``` > quote */

const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]+`)/

/** Convert inline markdown to WhatsApp formatting, leaving code spans untouched. */
export function inlineToWhatsApp(text: string): string {
	return text
		.split(CODE_SPAN)
		.map((part, i) => {
			if (i % 2 === 1) return part // code span
			let s = part
			// inline math $x^2$ (not "$5 and $6": the content must not start/end with a space or digit-only price)
			s = s.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (w, tex: string) => (/[\\^_{}]/.test(tex) ? latexToUnicode(tex) : w))
			s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_w, alt: string, url: string) => (alt ? `${alt}: ${url}` : url))
			s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_w, label: string, url: string) => (label === url ? url : `${label} (${url})`))
			// bold becomes a marker first, so the single-star italic pass below cannot mistake it for italics
			s = s.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/gs, '\u0001_$1_\u0002') // bold italic
			s = s.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gs, '\u0001$2\u0002') // bold
			s = s.replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g, '_$1_') // *italic*
			s = s.replace(/[\u0001\u0002]/g, '*')
			return s.replace(/~~(?=\S)(.+?)(?<=\S)~~/gs, '~$1~')
		})
		.join('')
}

/** Display width in a monospace font: CJK / full-width / most emoji take two cells. */
export function cellWidth(s: string): number {
	let w = 0
	for (const ch of s) {
		const c = ch.codePointAt(0)!
		if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x300 && c <= 0x36f)) continue
		w +=
			(c >= 0x1100 && c <= 0x115f) ||
			(c >= 0x2e80 && c <= 0xa4cf) ||
			(c >= 0xac00 && c <= 0xd7a3) ||
			(c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0xff00 && c <= 0xff60) ||
			(c >= 0x1f300 && c <= 0x1faff)
				? 2
				: 1
	}

	return w
}

const pad = (s: string, width: number, align: 'left' | 'right' | 'center') => {
	const gap = Math.max(0, width - cellWidth(s))
	if (align === 'right') return ' '.repeat(gap) + s
	if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2))
	return s + ' '.repeat(gap)
}

const stripInline = (s: string) =>
	s
		.replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

export interface TableTextOptions {
	/** monospace columns that fit a phone screen (default 34) */
	maxWidth?: number
}

/** A table as aligned monospace text, or as stacked records when it is too wide for a phone. */
export function tableToText(block: Extract<Block, { type: 'table' }>, opts: TableTextOptions = {}): string {
	const maxWidth = opts.maxWidth ?? 34
	const header = block.header.map(stripInline)
	const rows = block.rows.map(r => r.map(stripInline))
	const cols = header.length
	const widths = header.map((h, c) => Math.max(cellWidth(h), ...rows.map(r => cellWidth(r[c] ?? ''))))
	const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1)

	if (total <= maxWidth) {
		const line = (cells: string[]) => cells.map((c, i) => pad(c ?? '', widths[i]!, block.align[i] ?? 'left')).join(' │ ')
		const rule = widths.map(w => '─'.repeat(w)).join('─┼─')
		return '```\n' + [line(header), rule, ...rows.map(line)].join('\n') + '\n```'
	}

	// too wide: one small card per row, the first column is the title
	return rows
		.map(r => {
			const title = `*${r[0] || header[0] || ''}*`
			const rest = header.slice(1).map((h, i) => `${h}: ${r[i + 1] ?? ''}`)
			return [title, ...rest].join('\n')
		})
		.join('\n\n')
}

export interface RenderTextOptions extends TableTextOptions {
	/** how $$ blocks are shown when no image renderer is used: 'unicode' (default) or 'source' */
	math?: 'unicode' | 'source'
}

export function blockToText(b: Block, opts: RenderTextOptions = {}): string {
	switch (b.type) {
		case 'paragraph':
			return inlineToWhatsApp(b.text)
		case 'heading':
			return `*${inlineToWhatsApp(b.text).replace(/^\*(.*)\*$/s, '$1')}*`
		case 'code':
			return '```\n' + b.code.replace(/```/g, "'''") + '\n```'
		case 'table':
			return tableToText(b, opts)
		case 'math':
			return '```\n' + (opts.math === 'source' ? b.tex : latexToUnicode(b.tex)) + '\n```'
		case 'list':
			return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${inlineToWhatsApp(it)}`).join('\n')
		case 'quote':
			return b.text
				.split('\n')
				.map(l => `> ${inlineToWhatsApp(l)}`)
				.join('\n')
		case 'hr':
			return '──────────'
	}
}

/** One string per block, so callers can split a long answer between blocks (never inside a table or code block). */
export const renderBlocksToText = (blocks: Block[], opts: RenderTextOptions = {}): string[] => blocks.map(b => blockToText(b, opts))
