// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
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
vi.mock("./MemorySettingsOverlay", () => ({ MemorySettingsOverlay: () => null }));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));

import { SettingsOverlay } from "./SettingsOverlay";

const acme = { id: "space-a", name: "Acme" };

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

it("shows no space picker on sections that are not per space", async () => {
  const { container, cleanup } = await render({
    space: acme,
    initialSection: "general",
  });
  try {
    expect(container.querySelector('[data-testid="settings-space"]')).toBeNull();
  } finally {
    await cleanup();
  }
});
