/**
 * A small, dependency-free markdown reader. It only understands what a chat bot needs:
 * headings, paragraphs, lists, quotes, fenced code, tables and `$$ math $$` blocks.
 */

export type Block =
	| { type: 'paragraph'; text: string }
	| { type: 'heading'; level: number; text: string }
	| { type: 'code'; lang: string; code: string }
	| { type: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'right' | 'center'> }
	| { type: 'math'; tex: string }
	| { type: 'list'; ordered: boolean; items: string[] }
	| { type: 'quote'; text: string }
	| { type: 'hr' }

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const SEPARATOR_CELL = /^\s*:?-{1,}:?\s*$/

const splitRow = (line: string): string[] => {
	let s = line.trim()
	if (s.startsWith('|')) s = s.slice(1)
	if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
	const cells: string[] = []
	let cur = ''
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!
		if (ch === '\\' && s[i + 1] === '|') {
			cur += '|'
			i++
		} else if (ch === '|') {
			cells.push(cur.trim())
			cur = ''
		} else cur += ch
	}

	cells.push(cur.trim())
	return cells
}

const isTableSeparator = (line: string | undefined) => {
	if (!line || !line.includes('-')) return false
	const cells = splitRow(line)
	return cells.length > 0 && cells.every(c => SEPARATOR_CELL.test(c))
}

const alignOf = (cell: string): 'left' | 'right' | 'center' => {
	const c = cell.trim()
	if (c.startsWith(':') && c.endsWith(':')) return 'center'
	if (c.endsWith(':')) return 'right'
	return 'left'
}

export function parseMarkdown(input: string): Block[] {
	const lines = input.replace(/\r\n?/g, '\n').split('\n')
	const blocks: Block[] = []
	let para: string[] = []
	const flushPara = () => {
		if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') })
		para = []
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!

		// fenced code (the closing fence must be at least as long as the opening one)
		const fence = FENCE.exec(line)
		if (fence) {
			flushPara()
			const marker = fence[1]!
			const body: string[] = []
			i++
			while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) {
				body.push(lines[i]!)
				i++
			}

			blocks.push({ type: 'code', lang: (fence[2] ?? '').toLowerCase(), code: body.join('\n') })
			continue
		}

		// $$ math $$  (one line or several)
		const trimmed = line.trim()
		if (trimmed.startsWith('$$')) {
			flushPara()
			let tex = trimmed.slice(2)
			if (tex.endsWith('$$') && tex.length >= 2) {
				tex = tex.slice(0, -2)
			} else {
				const body = tex ? [tex] : []
				i++
				while (i < lines.length && !lines[i]!.includes('$$')) {
					body.push(lines[i]!)
					i++
				}

				if (i < lines.length) {
					const before = lines[i]!.slice(0, lines[i]!.indexOf('$$'))
					if (before.trim()) body.push(before)
				}

				tex = body.join('\n')
			}

			blocks.push({ type: 'math', tex: tex.trim() })
			continue
		}

		// \[ ... \] on its own lines
		if (trimmed === '\\[') {
			flushPara()
			const body: string[] = []
			i++
			while (i < lines.length && lines[i]!.trim() !== '\\]') {
				body.push(lines[i]!)
				i++
			}

			blocks.push({ type: 'math', tex: body.join('\n').trim() })
			continue
		}

		if (!trimmed) {
			flushPara()
			continue
		}

		// table: a row followed by a separator row
		if (line.includes('|') && isTableSeparator(lines[i + 1])) {
			flushPara()
			const header = splitRow(line)
			const align = splitRow(lines[i + 1]!).map(alignOf)
			const rows: string[][] = []
			i += 2
			while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
				const row = splitRow(lines[i]!)
				while (row.length < header.length) row.push('')
				rows.push(row.slice(0, Math.max(header.length, row.length)))
				i++
			}

			i--
			blocks.push({ type: 'table', header, rows, align })
			continue
		}

		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
		if (heading) {
			flushPara()
			blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! })
			continue
		}

		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flushPara()
			blocks.push({ type: 'hr' })
			continue
		}

		if (/^\s{0,3}>/.test(line)) {
			flushPara()
			const q: string[] = []
			while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
				q.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''))
				i++
			}

			i--
			blocks.push({ type: 'quote', text: q.join('\n') })
			continue
		}

		const bullet = /^\s{0,6}([-*+])\s+(.*)$/.exec(line)
		const numbered = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/.exec(line)
		if (bullet || numbered) {
			flushPara()
			const ordered = !!numbered
			const items: string[] = []
			while (i < lines.length) {
				const b = /^\s{0,6}([-*+])\s+(.*)$/.exec(lines[i]!)
				const n = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/.exec(lines[i]!)
				const m = ordered ? n : b
				if (m) items.push(m[2]!)
				else if (/^\s{2,}\S/.test(lines[i]!) && items.length) items[items.length - 1] += ' ' + lines[i]!.trim() // wrapped item
				else break
				i++
			}

			i--
			blocks.push({ type: 'list', ordered, items })
			continue
		}

		para.push(line)
	}

	flushPara()
	return blocks
}
