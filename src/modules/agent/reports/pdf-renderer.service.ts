import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as fontkit from 'fontkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { QueryResult } from '../agent.types';
import { cellRuns, isRtlLine, shapeRuns, type ShapedRun } from './arabic-text';

/**
 * Table PDFs with working Arabic.
 *
 * pdfkit rather than a headless browser on purpose: Chromium would give perfect
 * text layout and costs ~150MB of image plus a few hundred MB of RAM per render.
 * The on-prem box this ships to reported 1.87GB of container memory with 698MB
 * already in use, so the browser route is not available. pdfkit draws glyphs and
 * nothing else, which is why shaping happens in arabic-text.ts first.
 *
 * TWO fonts, switched per run. Noto Naskh Arabic carries 1415 glyphs and not one
 * is a Latin letter — not even a hyphen — so a document drawn entirely in it
 * renders every item code and English header as empty boxes. Latin runs go to
 * Helvetica, which pdfkit embeds for free.
 */

/** Bundled with the source; SIL OFL 1.1, see assets/fonts/OFL.txt. */
const FONT_FILE = 'NotoNaskhArabic-Regular.ttf';
const ARABIC_FONT = 'arabic';
const LATIN_FONT = 'Helvetica';

const PAGE = {
  margin: 36,
  rowHeight: 16,
  fontSize: 9,
  headerFontSize: 9.5,
  titleFontSize: 15,
  cellPad: 4,
};

@Injectable()
export class PdfRendererService {
  private readonly logger = new Logger(PdfRendererService.name);
  private readonly fontPath: string | null = this.locateFont();
  /** Opened once for glyph-coverage questions; pdfkit embeds it separately. */
  private readonly arabicFont = this.openFont();

  /**
   * @param landscape Defaults to true. A report table is wider than it is tall,
   *   and portrait squeezes columns until they are unreadable.
   */
  async render(
    result: QueryResult,
    title: string | null,
    landscape = true,
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: PAGE.margin,
      info: { Title: title ?? 'VanFlow report' },
      autoFirstPage: true,
    });

    let hasArabicFont = false;
    if (this.fontPath) {
      doc.registerFont(ARABIC_FONT, this.fontPath);
      hasArabicFont = true;
    } else {
      this.logger.warn(
        `Arabic font not found (${FONT_FILE}); Arabic text will render as ` +
          'boxes. Latin-only reports are unaffected.',
      );
    }

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.draw(doc, result, title, hasArabicFont);
    doc.end();
    return finished;
  }

  /**
   * Split an Arabic run wherever the Arabic font has no glyph.
   *
   * Noto Naskh Arabic has a space and Arabic punctuation but not, for example,
   * an em dash — which arrives constantly in report titles and rendered as an
   * empty box until this existed. Rather than maintain a list of what the font
   * is missing, ask it: any code point without a glyph is handed to Helvetica.
   */
  private splitByCoverage(runs: ShapedRun[]): ShapedRun[] {
    const font = this.arabicFont;
    if (!font) return runs;

    const out: ShapedRun[] = [];
    for (const run of runs) {
      if (!run.arabic) {
        out.push(run);
        continue;
      }
      let buf = '';
      let bufArabic = true;
      for (const ch of run.text) {
        const covered = font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0);
        if (buf && covered !== bufArabic) {
          out.push({ text: buf, arabic: bufArabic });
          buf = '';
        }
        bufArabic = covered;
        buf += ch;
      }
      if (buf) out.push({ text: buf, arabic: bufArabic });
    }
    return out;
  }

  /**
   * Draw one line of mixed-script runs at an exact position.
   *
   * pdfkit's own alignment cannot help here: it aligns a single string in a
   * single font, and this line may be three runs in two fonts. So the width is
   * measured first, the start x derived from it, and each run drawn in turn.
   */
  private drawRuns(
    doc: PDFKit.PDFDocument,
    input: ShapedRun[],
    x: number,
    y: number,
    width: number,
    align: 'left' | 'right',
    size: number,
    hasArabicFont: boolean,
  ): void {
    const runs = this.splitByCoverage(input);
    const font = (r: ShapedRun): string =>
      r.arabic && hasArabicFont ? ARABIC_FONT : LATIN_FONT;

    const widths = runs.map((r) => {
      doc.font(font(r)).fontSize(size);
      return doc.widthOfString(r.text);
    });
    const total = widths.reduce((s, w) => s + w, 0);

    // Overflow is clipped from the FAR side so the start of the text survives:
    // a truncated customer name is readable, a truncated-from-the-front one is
    // not. Right-aligned lines therefore shift left, never off their column.
    let cursor =
      align === 'right' ? x + width - Math.min(total, width) : x;

    runs.forEach((r, i) => {
      if (cursor > x + width) return;
      doc.font(font(r)).fontSize(size).text(r.text, cursor, y, {
        lineBreak: false,
        width: x + width - cursor,
        ellipsis: false,
      });
      cursor += widths[i];
    });
  }

  private draw(
    doc: PDFKit.PDFDocument,
    result: QueryResult,
    title: string | null,
    hasArabicFont: boolean,
  ): void {
    const { columns, rows } = result;
    const usableWidth = doc.page.width - PAGE.margin * 2;
    const colWidth = columns.length ? usableWidth / columns.length : usableWidth;

    // A report whose headers or data are Arabic is an Arabic report, and its
    // columns run right to left like everything else on the page.
    const rtl =
      columns.some((c) => isRtlLine(c)) ||
      rows.some((r) =>
        Object.values(r).some((v) => typeof v === 'string' && isRtlLine(v)),
      );
    const order = rtl ? [...columns].reverse() : columns;
    const align: 'left' | 'right' = rtl ? 'right' : 'left';

    let y = PAGE.margin;

    if (title) {
      this.drawRuns(
        doc,
        shapeRuns(title),
        PAGE.margin,
        y,
        usableWidth,
        align,
        PAGE.titleFontSize,
        hasArabicFont,
      );
      y += PAGE.titleFontSize + 8;
    }

    doc.fillColor('#666');
    this.drawRuns(
      doc,
      [{ text: `${rows.length} rows`, arabic: false }],
      PAGE.margin,
      y,
      usableWidth,
      align,
      8,
      hasArabicFont,
    );
    doc.fillColor('#000');
    y += 16;

    const header = (): void => {
      order.forEach((col, i) => {
        this.drawRuns(
          doc,
          shapeRuns(col),
          PAGE.margin + i * colWidth + PAGE.cellPad,
          y,
          colWidth - PAGE.cellPad * 2,
          align,
          PAGE.headerFontSize,
          hasArabicFont,
        );
      });
      y += PAGE.rowHeight;
      doc
        .moveTo(PAGE.margin, y - 3)
        .lineTo(PAGE.margin + usableWidth, y - 3)
        .strokeColor('#999')
        .lineWidth(0.7)
        .stroke();
      y += 3;
    };

    header();

    for (const row of rows) {
      // Page break BEFORE drawing, so no row is split across the fold, and the
      // header repeats so page four is readable on its own.
      if (y + PAGE.rowHeight > doc.page.height - PAGE.margin) {
        doc.addPage();
        y = PAGE.margin;
        header();
      }

      order.forEach((col, i) => {
        this.drawRuns(
          doc,
          cellRuns(row[col]),
          PAGE.margin + i * colWidth + PAGE.cellPad,
          y,
          colWidth - PAGE.cellPad * 2,
          align,
          PAGE.fontSize,
          hasArabicFont,
        );
      });
      y += PAGE.rowHeight;
    }

    if (rows.length === 0) {
      doc
        .font(LATIN_FONT)
        .fontSize(10)
        .fillColor('#888')
        .text('No rows.', PAGE.margin, y + 6);
    }
  }

  /**
   * The font sits next to the source in development and next to the compiled
   * output in the container, so both roots are tried. A missing font degrades
   * to a warning rather than a crash: a Latin-only report still renders.
   */
  private locateFont(): string | null {
    const candidates = [
      join(process.cwd(), 'assets', 'fonts', FONT_FILE),
      join(__dirname, '..', '..', '..', '..', 'assets', 'fonts', FONT_FILE),
      join(__dirname, 'fonts', FONT_FILE),
    ];
    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
    return null;
  }

  private openFont(): fontkit.Font | null {
    if (!this.fontPath) return null;
    try {
      const f = fontkit.openSync(this.fontPath);
      return 'hasGlyphForCodePoint' in f ? (f as fontkit.Font) : null;
    } catch (err) {
      this.logger.warn(`Could not open ${FONT_FILE} for coverage checks: ${String(err)}`);
      return null;
    }
  }
}
