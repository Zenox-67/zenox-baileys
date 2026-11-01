# Zenox rich messages

`sock.rich` is on every Zenox socket (turn off with `createZenox({ rich: false })`).

```ts
await sock.rich.send(jid, markdown, { quoted: m })          // bold, lists, quotes, code, tables, $$math$$
await sock.rich.sendButtons(jid, { body, buttons: [...] })  // native-flow buttons
```

## What is safe and what is not

| piece | status |
| --- | --- |
| `mode: 'text'` (default): WhatsApp formatting, code/table/math in monospace blocks | works on every client |
| "Lihat selengkapnya" (long answers are split; the rest is kept in redis) | built on a native-flow quick-reply button, so it needs button support; set `moreCommand: '.more'` for clients that do not draw buttons |
| `button.quickReply / url / copy / call / select / location` | names WhatsApp clients are known to understand; **not verified live here** |
| `mode: 'native'` (`richResponseMessage`: highlighted code, real tables, LaTeX) | layout taken from WAProto; **whether a non-bot account may send it, and which app versions draw it, must be tested live** |
| `button.custom(name, params)` | any other native-flow name. A brand-new button type cannot be invented from the bot side: the client decides what it draws |
| `createLatexImageRenderer()` (formulas as images, needs `mathjax-full` + `sharp`) | **not run in the sandbox it was written in**; falls back to Unicode text if it fails |

## Your own button types

`await sock.rich.action('Ya', 'konfirmasi', data)` makes a button whose tap runs
`sock.rich.onAction('konfirmasi', ({ data, jid }) => ...)`. `data` is stored in the cache / redis, so the
button keeps working after a restart.

## Tombol bintang

`button.star('Favorit', id)` memberi karakter teks ★ (bukan emoji) di label. Gambar bintang dari SVG: `starPng()` lalu `sendButtons(jid, { image, ... })`. WhatsApp tidak mengizinkan ikon kustom di dalam tombol; lihat [docs/zenox/buttons.md](../../../docs/zenox/buttons.md).
