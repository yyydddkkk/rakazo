// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
    i18n: { locale: "en" },
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    initialFocus: _initialFocus,
    ...props
  }: { children?: ReactNode; showCloseButton?: boolean; initialFocus?: unknown } & Omit<
    React.ComponentProps<"div">,
    "children"
  >) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: () => null,
  GeneralSettingsPanels: () => null,
  UsageSettingsPanel: () => null,
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));
vi.mock("./IntegrationsPanel", () => ({ IntegrationsPanel: () => null }));
vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("./MemorySettingsOverlay", () => ({ MemorySettingsOverlay: () => null }));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));

import { SettingsOverlay } from "./SettingsOverlay";

async function render(props: Partial<React.ComponentProps<typeof SettingsOverlay>>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = async (next: Partial<React.ComponentProps<typeof SettingsOverlay>>) => {
    await act(async () => {
      root.render(
        <SettingsOverlay
          name="Jamie"
          onUsageOpen={() => undefined}
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
          timezone={null}
          onTimezoneChange={async () => undefined}
          onClose={() => undefined}
          {...next}
        />,
      );
    });
  };
  await rerender(props);
  return {
    container,
    rerender,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

function navItems(container: HTMLElement, group: string) {
  return [...container.querySelectorAll(`[data-testid="settings-nav-group-${group}"] button`)].map(
    (button) => button.getAttribute("data-testid"),
  );
}

it("splits settings into account sections and the shown space's sections", async () => {
  const { container, cleanup } = await render({ spaceName: "Acme" });
  try {
    const account = container.querySelector('[data-testid="settings-nav-group-account"]');
    const space = container.querySelector('[data-testid="settings-nav-group-space"]');
    expect(account?.getAttribute("aria-label")).toBe("Account");
    expect(space?.getAttribute("aria-label")).toBe("Acme");
    expect(navItems(container, "account")).toEqual(["settings-nav-general"]);
    expect(navItems(container, "space")).toEqual([
      "settings-nav-models",
      "settings-nav-memory",
      "settings-nav-confirmations",
      "settings-nav-integrations",
      "settings-nav-usage",
    ]);
    expect(container.querySelector('[data-testid="settings-space"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

it("labels the space group generically until the space name is known", async () => {
  const { container, cleanup } = await render({});
  try {
    const space = container.querySelector('[data-testid="settings-nav-group-space"]');
    expect(space?.getAttribute("aria-label")).toBe("Space");
  } finally {
    await cleanup();
  }
});

it("offers messaging with the space's integrations", async () => {
  const onOpenMessaging = vi.fn();
  const integrations = await render({
    initialSection: "integrations",
    messagingEnabled: true,
    onOpenMessaging,
  });
  try {
    const open = [...integrations.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Manage messaging settings",
    );
    if (!open) throw new Error("Missing messaging button");
    await act(async () => open.click());
    expect(onOpenMessaging).toHaveBeenCalledOnce();
  } finally {
    await integrations.cleanup();
  }
});
