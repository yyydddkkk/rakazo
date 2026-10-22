import { t } from "@lingui/core/macro";
import { isVoiceAccountErrorCode } from "@rakazo/contracts";
import type { CredentialField } from "@rakazo/core";
import { authErrorMessage, userErrorMessage } from "@rakazo/core";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t`Could not reach the server` })
  );
}

/** Text for an RPC error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t`Your voice provider is out of credit.`
    : t`Your voice provider key was rejected.`;
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t`Enter a valid email` : t`Enter a password`;
}

/** Text for a failed Better Auth client result (`{ code, message }`). */
export function authErrorText(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "REAUTHENTICATION_REQUIRED") return t`Sign in again`;
  return authErrorMessage(error, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}
