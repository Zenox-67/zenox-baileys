/**
 * Tiny syntax tokenizer for WhatsApp's rich code blocks, which only know six colours:
 * default, keyword, method, string, number, comment. Language-agnostic on purpose: one regex pass,
 * keywords come from a union list, `#` comments are only enabled for the languages that use them.
 */

export type HighlightKind = 'default' | 'keyword' | 'method' | 'string' | 'number' | 'comment'

/** Same numbers as `AIRichResponseCodeMetadata.AIRichResponseCodeHighlightType`. */
export const HIGHLIGHT_ENUM: Record<HighlightKind, number> = {
	default: 0,
	keyword: 1,
	method: 2,
	string: 3,
	number: 4,
	comment: 5
}

export interface CodeToken {
	type: HighlightKind
	text: string
}

const KEYWORDS = new Set(
	(
		'abstract as async await break case catch class const continue debugger def default defer del delete do elif else enum ' +
		'except export extends false final finally fn for from func function go if impl implements import in instanceof interface ' +
		'is lambda let match mod mut namespace new nil none not null of or override package pass private protected pub public raise ' +
		'readonly return select self static struct super switch this throw trait true try type typeof undefined unsafe use using ' +
		'var void while with yield and print echo fi then done begin end local select from where join group order by insert into ' +
		'update values create table alter drop'
	).split(' ')
)

const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'dockerfile', 'r', 'pl', 'perl', 'ini', 'conf', 'makefile', 'nginx', 'env'])
const DASH_COMMENT = new Set(['sql', 'lua', 'hs', 'haskell'])
const NO_SLASH_COMMENT = new Set([...HASH_COMMENT, ...DASH_COMMENT])


export function tokenize(code: string, lang = ''): CodeToken[] {
	const l = lang.toLowerCase()
	const parts: string[] = []
	if (!NO_SLASH_COMMENT.has(l)) parts.push('(?<c1>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))')
	else parts.push('(?<c1>(?!x)x)') // never matches, keeps group numbering stable
	parts.push(`(?<c2>${HASH_COMMENT.has(l) ? '#[^\\n]*' : '(?!x)x'}|${DASH_COMMENT.has(l) ? '--[^\\n]*' : '(?!x)x'})`)
	parts.push('(?<str>"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?|`(?:\\\\.|[^`\\\\])*`?)')
	parts.push('(?<num>\\b(?:0[xX][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)')
	parts.push('(?<word>[A-Za-z_$][\\w$]*)')
	const re = new RegExp(parts.join('|'), 'g')

	const tokens: CodeToken[] = []
	const push = (type: HighlightKind, text: string) => {
		if (!text) return
		const last = tokens[tokens.length - 1]
		if (last && last.type === type) last.text += text
		else tokens.push({ type, text })
	}

	let pos = 0
	for (let m = re.exec(code); m; m = re.exec(code)) {
		if (m[0].length === 0) {
			re.lastIndex++
			continue
		}

		push('default', code.slice(pos, m.index))
		const g = m.groups!
		if (g.c1 || g.c2) push('comment', m[0])
		else if (g.str) push('string', m[0])
		else if (g.num) push('number', m[0])
		else if (g.word) {
			const next = code.slice(m.index + m[0].length).match(/^\s*\(/)
			if (KEYWORDS.has(g.word) || (l === 'sql' && KEYWORDS.has(g.word.toLowerCase()))) push('keyword', m[0])
			else if (next) push('method', m[0])
			else push('default', m[0])
		}

		pos = m.index + m[0].length
	}

	push('default', code.slice(pos))
	return tokens
}

