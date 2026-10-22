// @vitest-environment jsdom

import type { Space } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: pass,
    DropdownMenuContent: pass,
    DropdownMenuRadioGroup: pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    DropdownMenuItem: ({ children, onClick }: ComponentProps<"button">) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuRadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});
vi.mock("./dialogs", () => ({
  SpaceNameDialog: ({ space }: { space?: { name: string } }) => (
    <p>{space ? "rename dialog" : "new dialog"}</p>
  ),
  DeleteItemDialog: () => <p>delete dialog</p>,
}));

import { SpaceSwitcher } from "./space-switcher";

function space(overrides: Partial<Space> & Pick<Space, "id" | "name">): Space {
  return {
    isDefault: false,
    hasContent: false,
    canRename: true,
    canDelete: false,
    bots: [],
    groups: [],
    externalConversations: [],
    botSections: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(spaces: Space[], currentSpaceId: string) {
  await act(async () => {
    root.render(
      <SpaceSwitcher
        rpc={{} as never}
        spaces={spaces}
        currentSpaceId={currentSpaceId}
        refresh={async () => undefined}
      />,
    );
  });
}

function item(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SpaceSwitcher", () => {
  it("names the current space and lists every space", async () => {
    await render(
      [space({ id: "a", name: "Personal", isDefault: true }), space({ id: "b", name: "Support" })],
      "b",
    );
    expect(container.querySelector("[data-testid=space-switcher]")?.textContent).toBe("Support");
    expect(container.textContent).toContain("Personal");
  });

  it("offers delete only for a space the server says can be deleted", async () => {
    const spaces = [
      space({ id: "a", name: "Personal", isDefault: true }),
      space({ id: "b", name: "Empty", canDelete: true }),
    ];
    await render(spaces, "a");
    expect(item("Delete space")).toBeUndefined();
    await render(spaces, "b");
    expect(item("Delete space")).toBeDefined();
  });

  it("opens the new, rename and delete dialogs from the menu", async () => {
    await render(
      [
        space({ id: "a", name: "Personal", isDefault: true }),
        space({ id: "b", name: "Empty", canDelete: true }),
      ],
      "b",
    );
    for (const [label, dialog] of [
      ["New space", "new dialog"],
      ["Rename space", "rename dialog"],
      ["Delete space", "delete dialog"],
    ] as const) {
      await act(async () => item(label)?.click());
      expect(container.textContent).toContain(dialog);
    }
  });

  it("omits rename while a deletion is in progress", async () => {
    await render([space({ id: "a", name: "Personal", canRename: false })], "a");
    expect(item("Rename space")).toBeUndefined();
  });
});
