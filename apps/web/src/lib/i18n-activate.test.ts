import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateUiLocale,
  getActiveUiLocale,
  i18n,
  setCatalogLoadersForTests,
  setUiLocale,
} from "./i18n";
import { UI_LOCALE_STORAGE_KEY } from "./ui-locale";

vi.mock("./apply-ui-direction", () => ({ applyUiDirection: vi.fn() }));

function stubLocaleStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  });
  return store;
}

describe("activateUiLocale", () => {
  beforeEach(() => {
    setCatalogLoadersForTests(null);
    i18n.load("en", {});
    i18n.activate("en");
    vi.unstubAllGlobals();
  });

  it("falls back to English when the preferred catalog fails to load", async () => {
    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      "zh-CN": async () => {
        throw new Error("Chinese catalog missing");
      },
    });
    expect(await activateUiLocale("zh-CN")).toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("falls back to empty English when every catalog fails", async () => {
    setCatalogLoadersForTests({
      en: async () => {
        throw new Error("English catalog missing");
      },
      "zh-CN": async () => {
        throw new Error("Chinese catalog missing");
      },
    });
    expect(await activateUiLocale("zh-CN")).toBe("en");
    expect(i18n.locale).toBe("en");
  });

  it("lets the latest locale selection win under concurrency", async () => {
    let resolveEnglish!: (value: { messages: Record<string, string> }) => void;
    const english = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveEnglish = resolve;
    });
    setCatalogLoadersForTests({
      en: async () => english,
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
    });
    const first = activateUiLocale("en");
    const second = activateUiLocale("zh-CN");
    resolveEnglish({ messages: { Settings: "Settings" } });
    await expect(first).resolves.toBe("zh-CN");
    await expect(second).resolves.toBe("zh-CN");
    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("设置");
  });

  it("cancels a pending activation when re-selecting the already-active locale", async () => {
    let resolveChinese!: (value: { messages: Record<string, string> }) => void;
    const chinese = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveChinese = resolve;
    });
    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      "zh-CN": async () => chinese,
    });
    await activateUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");
    const pending = activateUiLocale("zh-CN");
    const backToEnglish = activateUiLocale("en");
    resolveChinese({ messages: { Settings: "设置" } });
    await expect(pending).resolves.toBe("en");
    await expect(backToEnglish).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("does not let a stale setUiLocale fallback overwrite the latest stored locale", async () => {
    const store = stubLocaleStorage();
    let rejectEnglish!: (error: Error) => void;
    const english = new Promise<never>((_resolve, reject) => {
      rejectEnglish = reject;
    });
    setCatalogLoadersForTests({
      en: async () => english,
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
    });
    const pendingEnglish = setUiLocale("en");
    const pendingChinese = setUiLocale("zh-CN");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
    rejectEnglish(new Error("English catalog missing"));
    await expect(pendingEnglish).resolves.toBe("zh-CN");
    await expect(pendingChinese).resolves.toBe("zh-CN");
    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });
});
