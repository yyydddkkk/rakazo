// @vitest-environment jsdom
import type { AccountSecurity } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchAccountSecurity } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { AccountAccess } from "./AccountAccess";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/account-security", () => ({
  fetchAccountSecurity: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  authClient: { deleteUser: vi.fn() },
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const security: AccountSecurity = {
  hasPassword: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render() {
  await act(async () => root.render(<AccountAccess />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function deleteButton() {
  return [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Delete account",
  )[1]!;
}
it("requires a password for account deletion", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue({ hasPassword: true });
  await render();
  await click("Delete account");
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(deleteButton().disabled).toBe(true);
});
it("refuses deletion if password credentials disappear before submission", async () => {
  vi.mocked(fetchAccountSecurity)
    .mockResolvedValueOnce({ hasPassword: true })
    .mockResolvedValue({ hasPassword: false });
  await render();
  await click("Delete account");
  const input = host.querySelector<HTMLInputElement>("#delete-password")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "example-password",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(deleteButton().disabled).toBe(false);
  await act(async () => deleteButton().click());
  expect(authClient.deleteUser).not.toHaveBeenCalled();
  expect(deleteButton().disabled).toBe(true);
});
it("does not allow passwordless account deletion", async () => {
  await render();
  await click("Delete account");
  expect(deleteButton().disabled).toBe(true);
});

it("sends the current password when deleting the account", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue({ hasPassword: true });
  vi.mocked(authClient.deleteUser).mockResolvedValue({
    data: null,
    error: {
      code: "REAUTHENTICATION_REQUIRED",
      message: "Sign in again",
      status: 403,
      statusText: "Forbidden",
    },
  });
  await render();
  await click("Delete account");
  const input = host.querySelector<HTMLInputElement>("#delete-password")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "example-password",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => deleteButton().click());
  expect(authClient.deleteUser).toHaveBeenCalledWith({ password: "example-password" });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign in again");
});
