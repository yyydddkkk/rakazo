import { i18n } from "@lingui/core";
import { normalizeRunError } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { translateRunError } from "./run-error";

afterEach(() => {
  i18n.activate("en");
});

it("uses the active Lingui catalog for shared run errors", () => {
  i18n.load("zh-CN", {
    "Your model provider": "你的模型提供商",
    "{provider} is rate limiting requests. Try again shortly.":
      "{provider}正在限制请求频率。请稍后重试。",
  });
  i18n.activate("zh-CN");
  expect(
    normalizeRunError(
      '429: {"message":"API key rate limit exceeded"}',
      translateRunError,
      i18n.locale,
    ).summary,
  ).toBe("你的模型提供商正在限制请求频率。请稍后重试。");
});
