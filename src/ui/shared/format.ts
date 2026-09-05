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
  const number = localeNumberFormat(locale, { maximumFractionDigits: 6 });
  const integer = localeNumberFormat(locale, { maximumFractionDigits: 0 });
  return {
    number: (value) => number.format(value),
    integer: (value) => integer.format(value),
  };
}

/**
 * Absent locale keeps English. Invalid tags fall back to English. Valid host
 * locales, including regional variants such as `fr-CA`, go directly to Intl.
 */
function localeNumberFormat(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const resolved = locale ?? DEFAULT_LOCALE;
  try {
    return new Intl.NumberFormat(resolved, options);
  } catch (error) {
    if (error instanceof RangeError) {
      return new Intl.NumberFormat(DEFAULT_LOCALE, options);
    }
    throw error;
  }
}
