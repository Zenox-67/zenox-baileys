# 1.1.0 (Zenox)

Nama paket menjadi `@zenox-67/baileys`.

- **Dokumentasi:** README baru, `docs/zenox/` (install, cara pakai, API, tombol, migrasi, performa, masalah umum, publish npm). README Baileys asli dipindah ke `docs/BAILEYS-API.md`.
- **Kirim ke grup:** cache data grup Zenox terisi otomatis saat kirim (sebelumnya tiap kirim ke grup bertanya ke server WhatsApp). Pemanasan setelah konek dan prefetch saat pesan masuk (`warmup`).
- **Reaksi:** `sock.react()` berurutan, membuang reaksi basi, mendukung `wait: false`.
- **HTTP:** klien keep-alive dengan cache DNS, retry, kompresi (`createHttpClient`, `zenoxFetch`); dipakai untuk unduh media dan thumbnail link.
- **Media:** enkripsi dan upload dari memori (tanpa file sementara) untuk media sampai 16 MB; upload dengan isi yang sama dipakai ulang; thumbnail dan metadata gambar paralel; pool koneksi upload.
- **Tombol:** `button.star()` (karakter ★, bukan emoji), `starSvg`/`starPng`/`svgToPng`, `sendButtons({ image })`.
- `WAMediaUploadFunction` kini punya `acceptsBuffer` dan `opts.buffer` (opsional; uploader buatan sendiri tidak terpengaruh).

# 7.0.0-rc14 (2026-07-29)



