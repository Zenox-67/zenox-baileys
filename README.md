# @zenox-67/baileys

Zenox Baileys adalah fork [Baileys](https://github.com/WhiskeySockets/Baileys) (basis `7.0.0-rc14`, MIT) untuk bot WhatsApp yang butuh **cepat dan tahan banting**: multisesi, Redis + cache, auto reconnect, auto save, pengiriman media yang dipercepat, klien HTTP keep-alive, reaksi cepat, pesan rich dan tombol.

Semua API Baileys asli tetap ada. Yang beda: nama paket, lapisan `createZenox`, dan beberapa percepatan di dalam.

## Install

```bash
# dari npm (setelah paket dipublish, lihat docs/zenox/publish-npm.md)
npm i @zenox-67/baileys

# dari GitHub (bisa dipakai sekarang, tanpa npm)
npm i @zenox-67/baileys@github:Zenox-67/zenox-baileys
```

Kebutuhan: **Node.js 20+**. Untuk thumbnail gambar pasang `sharp` (disarankan) atau `jimp`; untuk thumbnail video pasang `ffmpeg`.
Panduan lengkap (Termux, Windows, Linux, update, pindah dari Baileys lain): [docs/zenox/install.md](docs/zenox/install.md).

Nama yang tampil saat install dan di `package.json` bot adalah **`@zenox-67/baileys`**, bukan `@whiskeysockets/baileys`.

## Mulai cepat

```js
import { createZenox } from '@zenox-67/baileys'

const zenox = await createZenox({ sessionDir: './sessions', fetchLatestVersion: true })

zenox.on('pairing-code', ({ code }) => console.log('Kode pairing:', code))

zenox.onSocket((sock) => {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
      if (m.key.fromMe || text !== '.ping') continue
      sock.react(m, '⏳', { wait: false })                       // reaksi tanpa menunggu
      await sock.sendMessage(m.key.remoteJid, { text: 'pong' }, { quoted: m })
      sock.react(m, '✅', { wait: false })
    }
  })
})

const started = await zenox.startAll()                          // pulihkan sesi tersimpan
if (!started.length) await zenox.start('main', { pairingPhone: '628123456789' })
```

Login pertama: jalankan, masukkan kode pairing di **WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon**. Setelah itu sesi tersimpan dan bot langsung tersambung tanpa login ulang.

## Apa saja yang ada

| Bagian | Isi |
|---|---|
| **Sesi dan koneksi** | multisesi, auto reconnect (200 ms lalu naik bertahap), deteksi tidak ada internet, auto save saat proses mati, Redis opsional |
| **Respons cepat** | cache data grup terisi otomatis (sebelumnya tiap kirim ke grup menunggu server), pemanasan setelah konek, prefetch saat pesan masuk |
| **Media** | enkripsi di memori tanpa file sementara, upload gambar yang sama cuma sekali, thumbnail paralel, koneksi upload dipakai ulang |
| **HTTP / API** | klien keep-alive dengan cache DNS, retry, gzip/br, `zenoxFetch` yang bisa dipasang ke SDK mana pun |
| **Reaksi** | `sock.react()`: berurutan, reaksi basi dibuang, bisa tanpa menunggu |
| **Pesan rich** | `sock.rich`: markdown, kode, tabel, rumus, "Lihat selengkapnya" |
| **Tombol** | quick reply, url, salin, telepon, daftar pilihan, tombol bintang `★` (tanpa emoji), gambar bintang SVG di atas pesan |

Penjelasan jujur tentang apa yang dipercepat dan apa yang tidak bisa: [docs/zenox/performance.md](docs/zenox/performance.md).

## Dokumentasi

| Dokumen | Untuk apa |
|---|---|
| [docs/zenox/install.md](docs/zenox/install.md) | install lewat npm / GitHub, Termux, update |
| [docs/zenox/usage.md](docs/zenox/usage.md) | cara pakai yang benar, dari login sampai kirim media |
| [docs/zenox/api.md](docs/zenox/api.md) | semua opsi, event, method, `sock.react`, `sock.rich`, HTTP |
| [docs/zenox/buttons.md](docs/zenox/buttons.md) | tombol, tombol bintang, dan batas WhatsApp soal ikon |
| [docs/zenox/migration.md](docs/zenox/migration.md) | pindah dari `@whiskeysockets/baileys` / `baileys` |
| [docs/zenox/performance.md](docs/zenox/performance.md) | apa yang dipercepat, cara mengukur, tips |
| [docs/zenox/troubleshooting.md](docs/zenox/troubleshooting.md) | masalah umum dan solusinya |
| [docs/zenox/publish-npm.md](docs/zenox/publish-npm.md) | memasukkan paket ke npm |
| [docs/ZENOX.md](docs/ZENOX.md) | detail lapisan Zenox (sesi, Redis, reconnect, auto save) |
| [docs/BAILEYS-API.md](docs/BAILEYS-API.md) | referensi API Baileys dasar |

## Peringatan

Proyek ini tidak berafiliasi dengan, disetujui, atau didukung oleh WhatsApp atau Meta. WhatsApp tidak mengizinkan klien tidak resmi; akun bisa dibatasi atau diblokir, terutama kalau perilakunya menyerupai spam. Gunakan secara bertanggung jawab. Percepatan di paket ini tidak mengurangi risiko itu.

## Lisensi

MIT. Kode dasar: Baileys, hak cipta Rajeh Taher dan kontributor. File [LICENSE](LICENSE) asli wajib tetap ada di setiap salinan atau paket turunan.
