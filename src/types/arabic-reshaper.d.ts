/**
 * `arabic-reshaper` ships no types. Only the two functions we use are declared;
 * a blanket `declare module` would have made the import `any` and defeated the
 * strict-mode checking everywhere it is called.
 */
declare module 'arabic-reshaper' {
  /** Abstract Arabic letters → positional presentation forms. */
  export function convertArabic(text: string): string;
  /** Presentation forms → abstract letters. */
  export function convertArabicBack(text: string): string;

  const ArabicReshaper: {
    convertArabic: typeof convertArabic;
    convertArabicBack: typeof convertArabicBack;
  };
  export default ArabicReshaper;
}
