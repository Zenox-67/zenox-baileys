/**
 * JSON (de)serialisation that is byte-compatible with Baileys' own `BufferJSON`,
 * so session folders written by `useMultiFileAuthState` can be read and vice-versa.
 * Kept dependency-free on purpose (no import of Utils/generics).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const zxReplacer = (_k: string, value: any): any => {
	if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
		return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
	}

	return value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const zxReviver = (_k: string, value: any): any => {
	if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
		return Buffer.from(value.data, 'base64')
	}

	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const keys = Object.keys(value)
		if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
			const values = Object.values(value)
			if (values.every(v => typeof v === 'number')) {
				return Buffer.from(values as number[])
			}
		}
	}

	return value
}

export const zxStringify = (value: unknown): string => JSON.stringify(value, zxReplacer)

export const zxParse = <T = unknown>(raw: string): T => JSON.parse(raw, zxReviver) as T
