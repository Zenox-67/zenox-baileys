/**
 * Optional: render LaTeX to a PNG so formulas look like real math in chat.
 *
 *   npm i mathjax-full sharp
 *   const zenox = await createZenox({ rich: { latexImage: createLatexImageRenderer() } })
 *
 * Both packages are loaded lazily, only when a formula is rendered. If anything fails the function returns
 * `undefined` and the rich layer falls back to Unicode text, so a broken install never breaks a reply.
 *
 * NOTE: written against MathJax 3's public API but not run in the sandbox it was written in (no network, packages
 * not installed). Try one formula before relying on it.
 */

export interface LatexImageOptions {
	/** bigger = sharper and larger image (default 2.5) */
	scale?: number
	/** white border around the formula in px, so it is readable on dark chats too (default 24) */
	padding?: number
	/** formula colour (default #000000) */
	color?: string
	/** background colour (default #ffffff) */
	background?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const pick = (mod: any, name: string) => mod?.[name] ?? mod?.default?.[name]

export function createLatexImageRenderer(opts: LatexImageOptions = {}) {
	const scale = opts.scale ?? 2.5
	const padding = opts.padding ?? 24
	const color = opts.color ?? '#000000'
	const background = opts.background ?? '#ffffff'
	let loaded: Promise<{ toSvg: (tex: string) => string; sharp: any }> | undefined

	const load = () =>
		(loaded ??= (async () => {
			const imp = (name: string) => import(name) // variable name: no compile-time dependency on the optional packages
			const [mj, tex, svg, lite, html, all, sharpMod] = await Promise.all([
				imp('mathjax-full/js/mathjax.js'),
				imp('mathjax-full/js/input/tex.js'),
				imp('mathjax-full/js/output/svg.js'),
				imp('mathjax-full/js/adaptors/liteAdaptor.js'),
				imp('mathjax-full/js/handlers/html.js'),
				imp('mathjax-full/js/input/tex/AllPackages.js'),
				imp('sharp')
			])
			const adaptor = pick(lite, 'liteAdaptor')()
			pick(html, 'RegisterHTMLHandler')(adaptor)
			const doc = pick(mj, 'mathjax').document('', {
				InputJax: new (pick(tex, 'TeX'))({ packages: pick(all, 'AllPackages') }),
				OutputJax: new (pick(svg, 'SVG'))({ fontCache: 'none' })
			})
			return {
				toSvg: (t: string) => adaptor.innerHTML(doc.convert(t, { display: true })) as string,
				sharp: sharpMod.default ?? sharpMod
			}
		})().catch(err => {
			loaded = undefined // allow a retry after the packages get installed
			throw err
		}))

	return async (tex: string): Promise<{ buffer: Buffer; mimetype: string } | undefined> => {
		try {
			const { toSvg, sharp } = await load()
			let svg = toSvg(tex)
			if (!svg.includes('<svg')) return undefined
			// MathJax sizes the SVG in `ex` (1ex = 8px there); librsvg wants pixels
			const px = (v: string) => Math.max(1, Math.round(parseFloat(v) * 8 * scale))
			svg = svg
				.replace(/width="([\d.]+)ex"/, (_m, v: string) => `width="${px(v)}"`)
				.replace(/height="([\d.]+)ex"/, (_m, v: string) => `height="${px(v)}"`)
				.replace(/currentColor/g, color)
			const buffer: Buffer = await sharp(Buffer.from(svg))
				.flatten({ background })
				.extend({ top: padding, bottom: padding, left: padding, right: padding, background })
				.png()
				.toBuffer()
			return { buffer, mimetype: 'image/png' }
		} catch {
			return undefined
		}
	}
}
