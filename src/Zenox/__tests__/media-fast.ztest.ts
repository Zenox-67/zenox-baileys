import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import { describe, it } from 'node:test'
import {
	contentCacheKey,
	encryptMediaBuffer,
	parseCachedUpload,
	serializeCachedUpload,
	sha256,
	shareInflight,
	type CachedUpload
} from '../../Utils/media-fast'

const keys = () => ({ iv: Crypto.randomBytes(16), cipherKey: Crypto.randomBytes(32), macKey: Crypto.randomBytes(32) })

/** the algorithm of the streaming encryptedStream, copied step by step (chunks of 1000 bytes) */
const reference = (plain: Buffer, k: ReturnType<typeof keys>) => {
	const aes = Crypto.createCipheriv('aes-256-cbc', k.cipherKey, k.iv)
	const hmac = Crypto.createHmac('sha256', k.macKey).update(k.iv)
	const shaEnc = Crypto.createHash('sha256')
	const out: Buffer[] = []
	const onChunk = (b: Buffer) => {
		shaEnc.update(b)
		hmac.update(b)
		out.push(b)
	}

	for (let i = 0; i < plain.length; i += 1000) onChunk(aes.update(plain.subarray(i, i + 1000)))
	onChunk(aes.final())
	const mac = hmac.digest().subarray(0, 10)
	shaEnc.update(mac)
	out.push(mac)
	return { enc: Buffer.concat(out), fileEncSha256: shaEnc.digest(), mac }
}

const decrypt = (enc: Buffer, k: ReturnType<typeof keys>) => {
	const body = enc.subarray(0, enc.length - 10)
	const mac = enc.subarray(enc.length - 10)
	const expected = Crypto.createHmac('sha256', k.macKey).update(k.iv).update(body).digest().subarray(0, 10)
	assert.ok(mac.equals(expected), 'mac mismatch')
	const d = Crypto.createDecipheriv('aes-256-cbc', k.cipherKey, k.iv)
	return Buffer.concat([d.update(body), d.final()])
}

describe('encryptMediaBuffer', () => {
	for (const size of [0, 1, 15, 16, 17, 999, 1000, 65537, 3_000_000]) {
		it(`matches the streaming algorithm byte for byte (${size} bytes)`, () => {
			const plain = Crypto.randomBytes(size)
			const k = keys()
			const fast = encryptMediaBuffer(plain, k)
			const ref = reference(plain, k)
			assert.ok(fast.encBuffer.equals(ref.enc))
			assert.ok(fast.fileEncSha256.equals(ref.fileEncSha256))
			assert.ok(fast.mac.equals(ref.mac))
			assert.ok(fast.fileSha256.equals(sha256(plain)))
			assert.equal(fast.fileLength, size)
			assert.ok(decrypt(fast.encBuffer, k).equals(plain))
		})
	}
})

describe('content cache', () => {
	const entry = (ts: number): CachedUpload => ({
		v: 1,
		ts,
		mediaKey: 'a',
		fileEncSha256: 'b',
		fileSha256: 'c',
		fileLength: 3,
		mediaUrl: 'https://x',
		directPath: '/v/t',
		mediaKeyTimestamp: 1,
		extra: { width: 2 }
	})

	it('keys differ per media type and content', () => {
		const a = contentCacheKey('image', 'image', sha256(Buffer.from('a')))
		assert.notEqual(a, contentCacheKey('image', 'image', sha256(Buffer.from('b'))))
		assert.notEqual(a, contentCacheKey('sticker', 'sticker', sha256(Buffer.from('a'))))
		assert.equal(a, contentCacheKey('image', 'image', sha256(Buffer.from('a'))))
	})

	it('round trips and expires', () => {
		const now = Date.now()
		const raw = serializeCachedUpload(entry(now))
		assert.equal(parseCachedUpload(raw, now + 1000)?.mediaUrl, 'https://x')
		assert.equal(parseCachedUpload(raw, now + 2 * 60 * 60_000), undefined)
		assert.equal(parseCachedUpload('not json'), undefined)
		assert.equal(parseCachedUpload(undefined), undefined)
		assert.equal(parseCachedUpload(JSON.stringify({ v: 2 })), undefined)
	})
})

describe('shareInflight', () => {
	it('runs once for concurrent callers and again after it finished', async () => {
		const scope = {}
		let runs = 0
		const work = async () => {
			runs++
			await new Promise(r => setTimeout(r, 20))
			return runs
		}

		const [a, b] = await Promise.all([shareInflight(scope, 'k', work), shareInflight(scope, 'k', work)])
		assert.equal(a, 1)
		assert.equal(b, 1)
		assert.equal(await shareInflight(scope, 'k', work), 2)
		assert.equal(await shareInflight({}, 'k', work), 3) // another scope is independent
	})

	it('does not cache a failure', async () => {
		const scope = {}
		await assert.rejects(shareInflight(scope, 'k', async () => { throw new Error('x') }))
		assert.equal(await shareInflight(scope, 'k', async () => 5), 5)
	})
})
