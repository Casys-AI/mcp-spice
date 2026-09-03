/** Display formatting only. Callers still own units and field contracts. */

export interface NumberFormats {
  readonly number: (value: number) => string;
  readonly integer: (value: number) => string;
}

/** The viewers' own language; used when a host declares no locale. */
export const DEFAULT_LOCALE = "en";

/**
 * Figures follow the locale the host declares. When the host declares none the
 * viewer keeps its own language rather than the viewing machine's setting, so
 * the same result reads the same everywhere.
 */
export function numberFormats(locale: string | undefined): NumberFormats {
  const resolved = locale ?? DEFAULT_LOCALE;
  const number = new Intl.NumberFormat(resolved, { maximumFractionDigits: 6 });
  const integer = new Intl.NumberFormat(resolved, { maximumFractionDigits: 0 });
  return {
    number: (value) => number.format(value),
    integer: (value) => integer.format(value),
  };
}
