/**
 * `fontkit` arrives as a transitive dependency of pdfkit and ships no types.
 * Only the glyph-coverage surface the PDF renderer uses is declared — a blanket
 * `declare module` would have turned every call site into `any`.
 */
declare module 'fontkit' {
  export interface Font {
    familyName: string;
    numGlyphs: number;
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  /** Returns a Font, or a FontCollection for .ttc — hence the union. */
  export function openSync(path: string): Font | { fonts: Font[] };
}
