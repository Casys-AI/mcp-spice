/** Closed JSON helpers for untrusted MCP structuredContent. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} contains missing or unsupported fields.`);
  }
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const root = record(value, name);
  exactKeys(root, keys, name);
  return root;
}

export function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

export function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value as number;
}

export function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

export function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
}

export function numberMap(
  value: unknown,
  name: string,
): Record<string, number> {
  const input = record(value, name);
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      finiteNumber(item, `${name}.${key}`),
    ]),
  );
}

export function measurementMap(
  value: unknown,
  name: string,
): Record<string, { value: number }> {
  const input = record(value, name);
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => {
      const measurement = exactRecord(item, ["value"], `${name}.${key}`);
      return [
        key,
        { value: finiteNumber(measurement.value, `${name}.${key}.value`) },
      ];
    }),
  );
}

export function literal<T extends string | boolean>(
  value: unknown,
  expected: T,
  name: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${name} must be ${String(expected)}.`);
  }
  return expected;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
