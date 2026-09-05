import { assertEquals } from "@std/assert";
import { SPICE_MESSAGES_EN, SPICE_MESSAGES_FR, spiceMessages } from "./i18n.ts";

Deno.test("English is the default interface language", () => {
  const t = spiceMessages();
  assertEquals(t("technicalDetails"), "Technical details");
  assertEquals(t("loadingResult"), SPICE_MESSAGES_EN.loadingResult);
  assertEquals(t("executionState"), "Execution state");
});

Deno.test("French host locale selects interface labels without touching interpolations", () => {
  const t = spiceMessages("fr-CA");
  assertEquals(t("technicalDetails"), SPICE_MESSAGES_FR.technicalDetails);
  assertEquals(t("operatingPoint"), "Point de fonctionnement");
  assertEquals(t("recordedSession"), "Session enregistrée");
  assertEquals(t("project"), "Projet");
  assertEquals(t("projectRevision"), "Révision du projet");
  assertEquals(
    t("sessionRejected", {
      schema: "io.casys.mcp-spice.recorded-operating-point-session/1.0",
      detail: "the envelope failed the strict gate",
    }),
    "Session io.casys.mcp-spice.recorded-operating-point-session/1.0 rejetée : the envelope failed the strict gate",
  );
});

Deno.test("unknown or invalid locales keep the English dictionary", () => {
  assertEquals(spiceMessages("ja")("measurements"), "Measurements");
  assertEquals(spiceMessages("not a locale")("notChecked"), "Not checked");
});

Deno.test("dictionary locale names the selected catalog, not the host tag", () => {
  assertEquals(spiceMessages.locale(), "en");
  assertEquals(spiceMessages.locale("fr"), "fr");
  assertEquals(spiceMessages.locale("fr-CA"), "fr");
  assertEquals(spiceMessages.locale("fr-FR"), "fr");
  assertEquals(spiceMessages.locale("en-GB"), "en");
  assertEquals(spiceMessages.locale("ja"), "en");
  assertEquals(spiceMessages.locale("not a locale"), "en");
});
