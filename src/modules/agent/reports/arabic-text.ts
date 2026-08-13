import ArabicReshaper from 'arabic-reshaper';

/**
 * Arabic for PDF.
 *
 * PDF has no text layout engine. A viewer draws the glyphs it is handed, in the
 * order it is handed them, left to right. Two things therefore have to happen
 * before the text reaches pdfkit, and in this order:
 *
 *   1. SHAPE — Arabic letters change form by position in the word (initial,
 *      medial, final, isolated). Unicode stores the abstract letter; the font
 *      needs the presentation form. Without this step every word renders as
 *      disconnected letters, which is legible to nobody.
 *
 *   2. REORDER — Arabic reads right to left. Since the renderer draws left to
 *      right, an Arabic run must be handed over reversed. Latin words, digits
 *      and money figures embedded in that run must NOT be reversed, or invoice
 *      numbers and totals come out backwards.
 *
 * Shaping has to come first: contextual form depends on a letter's neighbours
 * in LOGICAL order, so reversing before shaping produces the wrong forms.
 *
 * This is a run-based approximation of the Unicode Bidirectional Algorithm, not
 * the full UBA. It handles what the reports actually contain — Arabic prose with
 * embedded numbers, item codes and Latin words — and it does so predictably. It
 * does not handle nested directional overrides, and does not need to.
 */

/** Arabic block, Arabic Supplement, Extended-A, and the presentation forms. */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Neutral between runs: spaces and the punctuation that separates them. */
const NEUTRAL = /[\s.,:;!?()[\]{}\-–—/\\|@#%&*+='"`~^_]/;

function isArabic(ch: string): boolean {
  return ARABIC.test(ch);
}

interface Run {
  text: string;
  rtl: boolean;
}

/**
 * Split into directional runs. Neutrals attach to the run before them so a
 * space between two Arabic words does not split the phrase into three runs.
 */
function toRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const neutral = NEUTRAL.test(ch);
    const rtl = isArabic(ch);
    const last = runs[runs.length - 1];

    if (last && (neutral || last.rtl === rtl)) {
      last.text += ch;
      continue;
    }
    runs.push({ text: ch, rtl });
  }
  return runs;
}

/** Reverse by code point, not by UTF-16 unit — surrogate pairs must stay whole. */
function reverse(text: string): string {
  return [...text].reverse().join('');
}

/** A piece of a line, already in draw order, tagged with the script it needs. */
export interface ShapedRun {
  text: string;
  /** True when this run must be drawn with the Arabic font. */
  arabic: boolean;
}

/**
 * Shape and order a line, returned as runs rather than one string.
 *
 * Runs, because no single bundled font covers both scripts. Noto Naskh Arabic
 * has 1415 glyphs and not one of them is a Latin letter — a report drawn
 * entirely in it renders "WIN-BASE-2789" as a row of empty boxes. The caller
 * draws each run with the font that has the glyphs.
 */
export function shapeRuns(input: string): ShapedRun[] {
  if (!input) return [];
  if (!ARABIC.test(input)) return [{ text: input, arabic: false }];

  const shaped = toRuns(input).map((run) =>
    run.rtl
      ? { text: reverse(ArabicReshaper.convertArabic(run.text)), arabic: true }
      : { text: run.text, arabic: false },
  );

  // RTL line: run order reverses, while each Latin run keeps its own reading.
  return shaped.reverse();
}

/**
 * Prepare one line of mixed text for drawing left-to-right.
 *
 * Returns the string unchanged when it contains no Arabic, so Latin-only
 * reports pay nothing for this.
 */
export function shapeForPdf(input: string): string {
  if (!input || !ARABIC.test(input)) return input;

  const runs = toRuns(input);

  // Shape each Arabic run in logical order, then reverse it for the renderer.
  const shaped = runs.map((run) =>
    run.rtl
      ? { ...run, text: reverse(ArabicReshaper.convertArabic(run.text)) }
      : run,
  );

  // Whole-line direction: an Arabic line lays its runs out right to left, so
  // the run ORDER reverses too — while each Latin/number run keeps its own
  // internal left-to-right reading.
  return shaped.reverse().map((r) => r.text).join('');
}

/** True when the line should be laid out right-to-left (alignment, columns). */
export function isRtlLine(input: string): boolean {
  return ARABIC.test(input);
}

/** Convenience for table cells: null/undefined render as an em dash. */
export function shapeCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return shapeForPdf(String(value));
}

/** Run form of shapeCell, for the PDF renderer. */
export function cellRuns(value: unknown): ShapedRun[] {
  if (value === null || value === undefined || value === '') {
    // A hyphen, not an em dash: the Arabic font has no dash glyph of any kind,
    // and Helvetica draws this one, so the empty marker stays visible.
    return [{ text: '-', arabic: false }];
  }
  return shapeRuns(String(value));
}
