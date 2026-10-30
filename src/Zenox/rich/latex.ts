/**
 * Best-effort LaTeX -> plain Unicode, for chats that cannot show real math.
 * It is deliberately simple: good for `x^2 + \alpha`, `\frac{a}{b}`, `\sqrt{x}`, sums and integrals.
 * Anything it does not understand is left as written, so nothing is silently lost.
 */

const SYMBOLS: Record<string, string> = {
	alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
	vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
	tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
	Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
	times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
	approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏',
	int: '∫', oint: '∮', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
	Leftrightarrow: '⇔', implies: '⇒', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
	cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', ldots: '…',
	cdots: '⋯', dots: '…', degree: '°', circ: '∘', angle: '∠', perp: '⊥', parallel: '∥', hbar: 'ħ', ell: 'ℓ',
	mathbb: '', langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': ''
}

const SUP: Record<string, string> = {
	'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
	'+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', k: 'ᵏ', m: 'ᵐ', t: 'ᵗ'
}

const SUB: Record<string, string> = {
	'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
	'+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', n: 'ₙ', m: 'ₘ', o: 'ₒ', x: 'ₓ'
}

/** `{...}` group starting at index `i` (which must be `{`). Returns the inside and the index after the closing brace. */
const readGroup = (s: string, i: number): [string, number] | undefined => {
	if (s[i] !== '{') return undefined
	let depth = 0
	for (let j = i; j < s.length; j++) {
		if (s[j] === '{') depth++
		else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1]
	}

	return undefined
}

const mapAll = (text: string, table: Record<string, string>) => {
	let out = ''
	for (const ch of text) {
		const m = table[ch]
		if (m === undefined) return undefined // cannot express it as super/subscript
		out += m
	}

	return out
}

const needsParens = (s: string) => /[^\p{L}\p{N}.]/u.test(s)

export function latexToUnicode(tex: string): string {
	let s = tex.trim()
	let guard = 0
	// \frac{a}{b}, \sqrt{x}, \text{..}, \mathbf{..} ... (innermost-first is not needed: we re-scan until stable)
	for (;;) {
		if (++guard > 200) break
		const m = /\\(frac|dfrac|tfrac|sqrt|text|textbf|mathrm|mathbf|mathit|mathbb|mathcal|operatorname|overline|vec|hat|bar)(?![a-zA-Z])/.exec(s)
		if (!m) break
		const cmd = m[1]!
		let i = m.index + m[0].length
		if (cmd === 'sqrt' && s[i] === '[') {
			const close = s.indexOf(']', i)
			if (close > 0) i = close + 1 // \sqrt[3]{x}: keep it simple, drop the index
		}

		while (s[i] === ' ') i++
		const a = readGroup(s, i)
		if (!a) {
			s = s.slice(0, m.index) + s.slice(m.index + m[0].length) // command without braces: drop the command name
			continue
		}

		let replacement: string
		let end = a[1]
		if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
			let j = a[1]
			while (s[j] === ' ') j++
			const b = readGroup(s, j)
			if (!b) {
				s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
				continue
			}

			const num = latexToUnicode(a[0])
			const den = latexToUnicode(b[0])
			replacement = `${needsParens(num) ? `(${num})` : num}⁄${needsParens(den) ? `(${den})` : den}`
			end = b[1]
		} else if (cmd === 'sqrt') {
			const inner = latexToUnicode(a[0])
			replacement = needsParens(inner) ? `√(${inner})` : `√${inner}`
		} else if (cmd === 'overline' || cmd === 'bar') {
			replacement = latexToUnicode(a[0]).replace(/(.)/gu, '$1\u0305')
		} else if (cmd === 'vec') {
			replacement = latexToUnicode(a[0]) + '\u20d7'
		} else if (cmd === 'hat') {
			replacement = latexToUnicode(a[0]) + '\u0302'
		} else {
			replacement = latexToUnicode(a[0])
		}

		s = s.slice(0, m.index) + replacement + s.slice(end)
	}

	// ^ and _ (single char or {group})
	s = s.replace(/([\^_])(\{[^{}]*\}|\\[a-zA-Z]+|.)/gu, (whole, op: string, arg: string) => {
		const raw = arg.startsWith('{') ? arg.slice(1, -1) : arg
		const text = latexToUnicode(raw)
		const mapped = mapAll(text, op === '^' ? SUP : SUB)
		if (mapped !== undefined) return mapped
		return `${op}${needsParens(text) ? `(${text})` : text}`
	})

	s = s.replace(/\\left|\\right|\\big|\\Big|\\bigg|\\displaystyle/g, '')
	s = s.replace(/\\([a-zA-Z]+|[,;:!])/g, (whole, name: string) => (Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name]! : whole))
	s = s.replace(/\\\\/g, '\n').replace(/&/g, ' ').replace(/\\([{}%$#_&])/g, '$1')
	return s.replace(/[{}]/g, '').replace(/[ \t]+/g, ' ').trim()
}
