import { describe, expect, it } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  UI_LOCALE_STORAGE_KEY,
} from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps English and Simplified Chinese regional tags onto supported locales", () => {
    for (const tag of ["en", "en-US", "en_GB", " EN "]) expect(normalizeUiLocale(tag)).toBe("en");
    for (const tag of [
      "zh-CN",
      "zh",
      "zh-Hans",
      "zh-Hans-CN",
      "zh-Hans-SG",
      "zh-SG",
      "zh_cn",
      "ZH-cn",
      " zh-CN ",
      "zh_Hans_CN",
    ]) {
      expect(normalizeUiLocale(tag)).toBe("zh-CN");
    }
  });

  it("does not fold Traditional Chinese into Simplified", () => {
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK"]) {
      expect(normalizeUiLocale(tag)).toBe("en");
    }
  });

  it("falls back to English for removed or unknown locales", () => {
    for (const tag of [
      "de-DE",
      "ko-KR",
      "pt-BR",
      "hi-IN",
      "es-MX",
      "ru-RU",
      "fr-CA",
      "he-IL",
      "iw-IL",
      "nl-BE",
      "tr",
      "sv-SE",
      "",
      null,
    ]) {
      expect(normalizeUiLocale(tag)).toBe("en");
    }
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and navigator", () => {
    expect(resolveUiLocale({ stored: "en", envDefault: "zh-CN", navigatorLanguage: "zh-CN" })).toBe(
      "en",
    );
    expect(resolveUiLocale({ stored: "zh-CN", envDefault: "en", navigatorLanguage: "en-US" })).toBe(
      "zh-CN",
    );
  });

  it("uses VITE_DEFAULT_UI_LOCALE when nothing is saved", () => {
    expect(
      resolveUiLocale({ stored: null, envDefault: "zh-Hans-SG", navigatorLanguage: "en-US" }),
    ).toBe("zh-CN");
  });

  it("uses navigator.language next, then English", () => {
    for (const [navigatorLanguage, expected] of [
      ["zh-CN", "zh-CN"],
      ["en-US", "en"],
      ["de-DE", "en"],
      [null, "en"],
    ]) {
      expect(resolveUiLocale({ stored: null, envDefault: null, navigatorLanguage })).toBe(expected);
    }
  });

  it("reads localStorage via the storage helper", () => {
    const storage = { getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "zh-CN" : null) };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("zh-CN");
  });
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("zh-CN", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });
});
