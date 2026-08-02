# Countswords

A multilingual word counter that actually understands scripts without spaces — Chinese, Japanese, Thai, Lao, Khmer, Burmese — via the native `Intl.Segmenter` API. No backend, no build step, no telemetry on your text.

**Live**: https://countswords.pages.dev

## Why

Most word counters split on whitespace. That silently breaks for roughly a quarter of the world's population — Chinese, Japanese, Thai, Lao, Khmer and Burmese text doesn't use spaces between words at all. `Intl.Segmenter` (Baseline 2024) solves this with the browser's own ICU dictionary-based segmentation, so this tool gets it right for 13 scripts out of the box, RTL included.

## Features

- **Real counting, not guessing**: words, graphemes (emoji/combining-mark safe), sentences, paragraphs, lexical density, reading/speaking time — script-aware (character-based pacing for CJK/Thai, word-based for the rest)
- **Auto-detects script** from a 4,000-character sample; manual override for 14 locales
- **Import** `.txt`, `.docx` (mammoth.js), `.pdf` (pdf.js) — both vendored, self-hosted, lazy-loaded only when used
- **Off the main thread**: counting runs in a Web Worker so a 500,000-character paste never freezes the tab
- **Zero backend**: everything runs in your browser; nothing you type is ever sent anywhere

## Security posture

This started as a throwaway tool and ended up with more hardening than it probably needed, documented here because the process is more interesting than the tool:

- Strict CSP, no `unsafe-inline` anywhere (inline `<script>`/`<style>` externalised, one residual inline `style=""` attribute removed and replaced with a CSS class)
- `mammoth.js` and `pdf.js` are self-hosted from the official npm packages instead of a CDN — no SRI to maintain, no third-party origin to trust at runtime
- PDF import never loads pdf.js's scripting sandbox — `/JavaScript` and `/OpenAction` actions embedded in a malicious PDF are structurally unable to execute (verified empirically, see below)
- **Fuzz-tested against real malicious files**: garbage bytes, corrupt ZIP/PDF structure, XXE payloads, a PDF with an embedded `/OpenAction` JavaScript payload, and a 50KB `.docx` that decompresses to 52MB (a zip bomb). Found that mammoth.js has no built-in decompression-size limit — patched with a Central-Directory size/ratio guard that runs before any decompression happens. Full write-up in the blog post below.
- Per-operation timeouts on file import (a hostile PDF content stream took 5.3s to parse in testing — now capped)

## Stack

Vanilla JS, no framework, no bundler. `Intl.Segmenter` for text analysis, Web Worker for the hot path, `mammoth.js` / `pdf.js` for import. Deployed on Cloudflare Pages.

## Local development

It's a static site — no build step.

```bash
git clone https://github.com/amateogr/CountWords.git
cd CountWords
python3 -m http.server 8000   # or any static file server
```

## License

MIT
