// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant ?? "default"} data-size={size} {...props}>
      {children}
    </button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { email: vi.fn() },
    requestPasswordReset: vi.fn(),
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
const capabilities: AuthCapabilities = {
  passwordReset: false,
  resetUrl: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function render(mode: "in" | "forgot" = "in") {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AuthPage mode={mode} />} />
          <Route path="/app" element={<p>App</p>} />
          <Route path="/onboarding" element={<p>Onboarding</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function enter(input: Element | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === text)!;
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}
it("shows no credential form while capabilities load", async () => {
  vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
  await render();
  expect(host.querySelector("input")).toBeNull();
});
it("signs in with email and password", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.email).mockResolvedValue({ data: null, error: null });
  await render();
  await enter(host.querySelector("#email"), "owner@example.test");
  await enter(host.querySelector("#current-password"), "example-password");
  await submit();
  expect(authClient.signIn.email).toHaveBeenCalledWith({
    email: "owner@example.test",
    password: "example-password",
  });
  expect(host.textContent).toBe("App");
});
it("shows recovery only when configured", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    passwordReset: true,
    resetUrl: "https://example.test/reset-password",
  });
  await render();
  expect(host.querySelector('a[href="/forgot-password"]')).not.toBeNull();
  expect(host.querySelector('a[href="/sign-up"]')).toBeNull();
});
it("does not offer recovery when it is unavailable", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  expect(host.querySelector('a[href="/forgot-password"]')).toBeNull();
});
it("retries capabilities after a failed lookup", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue(capabilities);
  await render();
  await act(async () => button("Retry").click());
  expect(host.querySelector("#current-password")).not.toBeNull();
});

it("requests password recovery using the configured reset URL", async () => {
  const resetUrl = "https://example.test/reset-password";
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ passwordReset: true, resetUrl });
  vi.mocked(authClient.requestPasswordReset).mockResolvedValue({ data: null, error: null });
  await render("forgot");
  await enter(host.querySelector("#email"), "owner@example.test");
  await submit();
  expect(authClient.requestPasswordReset).toHaveBeenCalledWith({
    email: "owner@example.test",
    redirectTo: resetUrl,
  });
  expect(host.textContent).toContain("Check your email");
});
