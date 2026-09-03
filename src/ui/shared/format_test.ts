import { assertEquals } from "@std/assert";
import { DEFAULT_LOCALE, numberFormats } from "./format.ts";

Deno.test("figures follow the locale the host declares", () => {
  assertEquals(numberFormats("en-US").number(-0.001), "-0.001");
  assertEquals(numberFormats("de-DE").number(-0.001), "-0,001");
  assertEquals(numberFormats("en-US").integer(12345.6), "12,346");
  assertEquals(numberFormats("de-DE").integer(12345.6), "12.346");
});

Deno.test("a host that declares no locale gets the viewers' language, not the machine's", () => {
  // The UI suite runs under LC_ALL=de_DE.UTF-8 (src/ui/test.ts), so a fallback to the
  // machine locale would spell the decimal separator as a comma here.
  assertEquals(DEFAULT_LOCALE, "en");
  assertEquals(numberFormats(undefined).number(1234.5), "1,234.5");
  assertEquals(
    numberFormats(undefined).number(-0.001),
    numberFormats(DEFAULT_LOCALE).number(-0.001),
  );
});

Deno.test("figures keep at most six fractional digits", () => {
  assertEquals(numberFormats("en-US").number(0.1234567891), "0.123457");
  assertEquals(numberFormats("en-US").number(24), "24");
});
