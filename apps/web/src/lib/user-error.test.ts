import { describe, expect, it } from "vitest";
import { authErrorText } from "./user-error";

describe("authErrorText", () => {
  it("asks for a fresh sign-in when reauthentication is required", () => {
    expect(
      authErrorText({ code: "REAUTHENTICATION_REQUIRED", message: "Server message" }, "Fallback"),
    ).toBe("Sign in again");
  });

  it("keeps messages from older servers", () => {
    expect(authErrorText({ message: "Invalid email or password" }, "Fallback")).toBe(
      "Invalid email or password",
    );
  });
});
