# Kebijakan keamanan

## Melaporkan kerentanan

**Jangan laporkan celah keamanan lewat issue publik.** Laporan publik memberi tahu semua orang sebelum ada perbaikan.

Pakai **GitHub Security Advisories** di repo ini: https://github.com/Zenox-67/zenox-baileys/security/advisories/new

Sertakan: versi (tag atau commit), komponen yang terdampak (socket, enkripsi, auth state, media, ...), dampaknya, cara mereproduksi (kode minimal; jangan lampirkan isi folder sesi), dan usulan perbaikan kalau ada.

Celah yang ada di Baileys asli (bukan di tambahan Zenox) sebaiknya juga dilaporkan ke proyek asalnya: https://github.com/WhiskeySockets/Baileys/security/advisories

## Yang dianggap celah

- kebocoran atau penurunan keamanan auth state / penyimpanan kunci;
- penanganan sesi/kunci Signal yang memungkinkan penyamaran atau dekripsi di luar penerima yang sah;
- korupsi memori / eksekusi kode lewat stanza, media, atau payload protobuf yang dibuat khusus;
- kebocoran informasi pribadi (nomor, isi pesan, token) lewat log atau pesan error pada konfigurasi default;
- celah pada dependensi yang bisa dicapai lewat API publik.

Bukan celah: proses lokal yang crash karena input yang salah di kode kamu sendiri, perilaku server WhatsApp, atau penyalahgunaan library untuk spam.

## Saran bagi pemakai

- **Folder sesi (`sessions/`, `zenox-sessions/`, `baileys_auth_info/`) setara password akun.** Jangan di-commit, jangan masuk ke image container, jangan ditempel ke AI, screenshot, atau tiket bantuan.
- Log default memuat JID dan metadata pesan; set `level: 'silent'` atau saring di produksi.
- **Kunci versi.** Memasang dari GitHub tanpa tag selalu mengambil branch terbaru. Pakai tag rilis, mis. `github:Zenox-67/zenox-baileys#v1.1.0`, atau versi npm yang pasti.
- Token npm untuk publish otomatis: gunakan token *granular* yang hanya berlaku untuk satu paket, simpan di GitHub Secrets.

## Versi yang didukung

Perbaikan keamanan diberikan untuk rilis terbaru lini `1.x`.
