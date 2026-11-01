/**
 * Star icon without emoji.
 *
 * What WhatsApp allows: the picture next to a native-flow button (reply arrow, link, copy...) is chosen by the app from the
 * button TYPE; a bot cannot hand it an SVG. So there are two honest options here:
 *  1. `STAR_GLYPH`: the text character U+2605 (a font glyph, not an emoji; the U+FE0E selector asks apps not to turn it into one).
 *     `button.star('Favorit', id)` puts it in front of the label.
 *  2. A star drawn from SVG and sent as the picture on top of the message (`image` of `sendButtons`).
 */

/** U+2605 BLACK STAR + text presentation selector. Not the emoji (U+2B50). */
export const STAR_GLYPH = '★︎'

export interface StarSvgOptions {
	/** fill color (default WhatsApp-like gold) */
	color?: string
	/** background color, `none` for transparent (default none) */
	background?: string
	/** side of the square picture in px (default 256) */
	size?: number
}

/** A five-point star as SVG text. */
export const starSvg = ({ color = '#F5B301', background = 'none', size = 256 }: StarSvgOptions = {}): string => {
	const bg = background === 'none' ? '' : `<rect width="100" height="100" rx="18" fill="${background}"/>`
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
		bg +
		`<polygon fill="${color}" points="50,10 61.8,36.6 90.8,39.5 69,59 75.5,87.4 50,72.6 24.5,87.4 31,59 9.2,39.5 38.2,36.6"/>` +
		`</svg>`
	)
}

/** The minimal part of `sharp` that is needed here */
type SharpLike = (input: Buffer, options?: { density?: number }) => { resize(w: number, h?: number): { png(): { toBuffer(): Promise<Buffer> } } }

/**
 * Draw SVG text to a PNG. Needs `sharp` (`npm i sharp`), which Baileys already uses for thumbnails when present.
 * Pass `sharp` yourself if it is installed somewhere the package cannot see.
 */
export const svgToPng = async (svg: string, opts: { size?: number; sharp?: SharpLike } = {}): Promise<Buffer> => {
	const size = opts.size ?? 256
	let sharp = opts.sharp
	if (!sharp) {
		// @ts-ignore optional dependency
		const mod: any = await import('sharp').catch(() => undefined)
		sharp = (mod?.default ?? mod) as SharpLike | undefined
	}

	if (typeof sharp !== 'function') {
		throw new Error('svgToPng needs the "sharp" package: npm i sharp')
	}

	return sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer()
}

/** PNG of the star, ready for `rich.sendButtons(jid, { image: await starPng(), ... })` */
export const starPng = (opts: StarSvgOptions & { sharp?: SharpLike } = {}) => {
	const { sharp, ...svgOptions } = opts
	return svgToPng(starSvg(svgOptions), { size: svgOptions.size ?? 256, ...(sharp ? { sharp } : {}) })
}
