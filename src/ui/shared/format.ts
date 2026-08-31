/** Display formatting only. Callers still own units and field contracts. */

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(
    value,
  );
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}
