import { createAuth } from "@rakazo/auth";
import { describe, expect, it } from "vitest";
import { isTrustedOrigin } from "./app.js";

// Better Auth skips its origin middleware under NODE_ENV=test, so check the
// matcher that production uses for callback URLs and request origins.
async function trusted(url: string) {
  const auth = createAuth({} as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
    signupsEnabled: undefined,
    signupAllowlist: undefined,
  });
  return (await auth.$context).isTrustedOrigin(url);
}

const env = {
  webOrigin: "http://127.0.0.1:5173",
  apiUrl: "http://127.0.0.1:3100",
  authUrl: "http://127.0.0.1:5173",
};

describe("CORS origins", () => {
  it("allows the configured site and its loopback twin", () => {
    for (const origin of [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:3100",
      "",
    ]) {
      expect(isTrustedOrigin(origin, env), origin).toBe(true);
    }
  });

  it("accepts the configured site when env values keep a trailing slash", () => {
    const envWithSlash = {
      webOrigin: "http://127.0.0.1:5173/",
      apiUrl: "http://127.0.0.1:3100/",
      authUrl: "http://127.0.0.1:5173/",
    };
    expect(isTrustedOrigin("http://127.0.0.1:5173", envWithSlash)).toBe(true);
    expect(isTrustedOrigin("http://localhost:5173", envWithSlash)).toBe(true);
  });

  it("rejects any other loopback port and any public origin", () => {
    for (const origin of [
      "http://127.0.0.1:9",
      "http://localhost:45173",
      "http://[::1]:9",
      "https://evil.example",
      "http://localhost:8081",
      "http://127.0.0.1:19006",
      "rakazo://sign-in",
      "exp://192.168.1.20:8081",
    ]) {
      expect(isTrustedOrigin(origin, env), origin).toBe(false);
    }
  });
});

describe("auth callback origins", () => {
  it("does not trust an arbitrary Expo host as a callback", async () => {
    for (const url of [
      "exp://attacker.example.test:19000/--/verification-lure",
      "exp://192.168.1.20:8081",
      "exp://",
    ]) {
      expect(await trusted(url), url).toBe(false);
    }
  });

  it("accepts the configured web origin", async () => {
    expect(await trusted("https://app.example.test/sign-in")).toBe(true);
  });

  it("rejects the removed native scheme and dev servers", async () => {
    for (const url of ["rakazo://sign-in", "http://localhost:8081/sign-in"]) {
      expect(await trusted(url), url).toBe(false);
    }
  });
});
