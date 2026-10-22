import { beforeEach, describe, expect, it } from "vitest";
import { applyUiDirection } from "./apply-ui-direction";

describe("applyUiDirection", () => {
  beforeEach(() => {
    globalThis.document = {
      documentElement: {
        dir: "",
        lang: "",
      },
    } as Document;
  });

  it("sets ltr document direction for Simplified Chinese", () => {
    expect(applyUiDirection("zh-CN")).toBe("ltr");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("sets ltr document direction for English", () => {
    expect(applyUiDirection("en-US")).toBe("ltr");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en-US");
  });
});
