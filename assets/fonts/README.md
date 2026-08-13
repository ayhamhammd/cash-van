# Bundled fonts

## NotoNaskhArabic-Regular.ttf

Source: <https://github.com/notofonts/notofonts.github.io> (Noto Project)
Licence: **SIL Open Font License 1.1** — redistribution inside this application
is permitted; the font is not sold on its own and is not renamed.

Used by `PdfRendererService` to draw Arabic in generated PDF reports. pdfkit's
built-in fonts contain no Arabic glyphs at all, so without this file every
Arabic character in a PDF renders as an empty box.

### What it does not cover

1,415 glyphs, **none of them Latin letters** — not even a hyphen. Latin runs are
drawn in Helvetica instead, which pdfkit embeds for free; `PdfRendererService`
switches font per run and asks the font itself (`hasGlyphForCodePoint`) before
sending any character to it, so a missing glyph falls back rather than printing
a box.

### Replacing it

Any OFL Arabic TTF works. Drop it in, update `FONT_FILE` in
`pdf-renderer.service.ts`, and re-render a report with mixed Arabic and Latin
before trusting it — coverage gaps only show up on the page.
