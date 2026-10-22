import { z } from "zod";

export const authCapabilitiesSchema = z.object({
  passwordReset: z.boolean(),
  resetUrl: z.string().url().nullable(),
});
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  passwordChangeEnabled: z.boolean().optional(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
};
