/**
 * Zenox fast media path (pure helpers, Node built-ins only).
 *
 * The stock flow for every media message is: stream -> encrypt -> write a temp file -> read the temp file back to
 * upload it -> delete the temp file. For the usual bot payload (a picture, sticker, short audio or clip that is already
 * in memory, up to a few MB) that disk round trip is pure overhead. The helpers here encrypt a Buffer in one go,
 * and remember uploads by the SHA-256 of the content, so the same picture (a menu image, a logo) is uploaded once
 * and reused for every following message.
 */
import * as Crypto from 'crypto'

/** Media up to this size takes the in-memory path; larger media keeps using the streaming/temp file path. */
export let FAST_MEDIA_MAX_BYTES = 16 * 1024 * 1024
/** How long an upload is reused (WhatsApp media links expire; Zenox's own media cache uses 1 hour as well). */
export let CONTENT_CACHE_TTL_MS = 60 * 60_000

export const configureFastMedia = (opts: { maxBytes?: number; cacheTtlMs?: number }) => {
	if (opts.maxBytes !== undefined) FAST_MEDIA_MAX_BYTES = Math.max(0, opts.maxBytes)
	if (opts.cacheTtlMs !== undefined) CONTENT_CACHE_TTL_MS = Math.max(0, opts.cacheTtlMs)
}

export type MediaCipherKeys = {
	iv: Uint8Array
	cipherKey: Uint8Array
	macKey?: Uint8Array
}

export type EncryptedMediaBuffer = {
	/** ciphertext + 10-byte MAC, exactly what the temp file used to hold */
	encBuffer: Buffer
	mac: Buffer
	fileSha256: Buffer
	fileEncSha256: Buffer
	fileLength: number
}

/** Same bytes as the streaming `encryptedStream` (AES-256-CBC, HMAC-SHA256 over iv + ciphertext, first 10 bytes). */
export const encryptMediaBuffer = (plain: Buffer, keys: MediaCipherKeys, fileSha256?: Buffer): EncryptedMediaBuffer => {
	if (!keys.macKey) {
		throw new Error('media keys without macKey')
	}

	const aes = Crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([aes.update(plain), aes.final()])
	const mac = Crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	const encBuffer = Buffer.concat([ciphertext, mac])
	return {
		encBuffer,
		mac,
		fileSha256: fileSha256 ?? Crypto.createHash('sha256').update(plain).digest(),
		fileEncSha256: Crypto.createHash('sha256').update(encBuffer).digest(),
		fileLength: plain.length
	}
}

export const sha256 = (data: Buffer) => Crypto.createHash('sha256').update(data).digest()

// ---------------------------------------------------------------------------------------------------------------------
// content-addressed upload cache
// ---------------------------------------------------------------------------------------------------------------------

/** Everything needed to build the message again without uploading. Strings only, so any cache backend can hold it. */
export type CachedUpload = {
	v: 1
	ts: number
	mediaKey: string
	fileEncSha256: string
	fileSha256: string
	fileLength: number
	mediaUrl: string
	directPath: string
	mediaKeyTimestamp: number
	/** values computed from the content (all optional) */
	extra: {
		jpegThumbnail?: string
		width?: number
		height?: number
		seconds?: number
		waveform?: string
	}
}

export const contentCacheKey = (mediaType: string, encType: string, fileSha256: Buffer) =>
	`zmc:${mediaType}:${encType}:${fileSha256.toString('hex')}`

export const serializeCachedUpload = (value: CachedUpload) => JSON.stringify(value)

export const parseCachedUpload = (raw: unknown, now = Date.now(), ttlMs = CONTENT_CACHE_TTL_MS): CachedUpload | undefined => {
	if (typeof raw !== 'string') return undefined
	try {
		const value = JSON.parse(raw) as CachedUpload
		if (value?.v !== 1 || !value.mediaKey || !value.fileEncSha256 || !(value.mediaUrl || value.directPath)) return undefined
		if (now - value.ts > ttlMs) return undefined
		return value
	} catch {
		return undefined
	}
}

/**
 * Runs `work` once for each key while it is in flight: a second caller with the same key gets the same promise.
 * `scope` separates unrelated sockets/caches.
 */
const inflight = new WeakMap<object, Map<string, Promise<unknown>>>()
export const shareInflight = <T>(scope: object, key: string, work: () => Promise<T>): Promise<T> => {
	let map = inflight.get(scope)
	if (!map) {
		map = new Map()
		inflight.set(scope, map)
	}

	const existing = map.get(key)
	if (existing) return existing as Promise<T>

	const promise = work()
	map.set(key, promise)
	const clear = () => {
		if (map!.get(key) === promise) map!.delete(key)
	}

	promise.then(clear, clear)
	return promise
}
