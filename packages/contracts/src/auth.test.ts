import { expect, it } from "vitest";
import { accountSecuritySchema, authCapabilitiesSchema } from "./auth.js";

it("requires explicit password recovery capabilities", () => {
  expect(authCapabilitiesSchema.parse({ passwordReset: false, resetUrl: null })).toEqual({
    passwordReset: false,
    resetUrl: null,
  });
  expect(authCapabilitiesSchema.safeParse({}).success).toBe(false);
  expect(
    authCapabilitiesSchema.safeParse({ passwordReset: true, resetUrl: "invalid" }).success,
  ).toBe(false);
});

it("accepts password account security and explicit password-change policy", () => {
  expect(accountSecuritySchema.parse({ hasPassword: true }).passwordChangeEnabled).not.toBe(false);
  expect(
    accountSecuritySchema.parse({ hasPassword: true, passwordChangeEnabled: false })
      .passwordChangeEnabled,
  ).toBe(false);
  expect(
    accountSecuritySchema.safeParse({ hasPassword: true, passwordChangeEnabled: "false" }).success,
  ).toBe(false);
});
