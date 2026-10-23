// @vitest-environment jsdom

import type { Space } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Choose = createContext<(value: string) => void>(() => undefined);
  return {
    DropdownMenu: pass,
    DropdownMenuContent: pass,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange: (value: string) => void;
    }) => <Choose.Provider value={onValueChange}>{children}</Choose.Provider>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    DropdownMenuItem: ({ children, onClick }: ComponentProps<"button">) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuRadioItem: function RadioItem({
      children,
      value,
    }: {
      children?: ReactNode;
      value: string;
    }) {
      const choose = useContext(Choose);
      return (
        <button type="button" data-value={value} onClick={() => choose(value)}>
          {children}
        </button>
      );
    },
  };
});
vi.mock("../../lib/rpc", () => ({ selectSpace: () => true }));
vi.mock("./dialogs", () => ({
  NewSpaceDialog: () => <p>new dialog</p>,
  RenameSpaceDialog: () => <p>rename dialog</p>,
  DeleteItemDialog: () => <p>delete dialog</p>,
}));

import { SpaceSwitcher, spaceHasUnread } from "./space-switcher";

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

const unreadBot = { unread: true } as Space["bots"][number];
const unreadGroup = { unread: true } as Space["groups"][number];

let container: HTMLDivElement;
let root: Root;

async function render(
  spaces: Space[],
  currentSpaceId: string,
  extra: { mini?: boolean; onSwitch?: (spaceId: string) => void } = {},
) {
  await act(async () => {
    root.render(
      <SpaceSwitcher
        rpc={{} as never}
        spaces={spaces}
        currentSpaceId={currentSpaceId}
        onSwitch={extra.onSwitch ?? (() => undefined)}
        setSpaces={() => undefined}
        refresh={async () => undefined}
        mini={extra.mini}
      />,
    );
  });
}

function item(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
}

const trigger = () => container.querySelector("[data-testid=space-switcher]");
const dotsIn = (node: Element | null | undefined) =>
  node?.querySelectorAll("[data-space-unread-dot]").length ?? 0;

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

describe("spaceHasUnread", () => {
  it("is true for an unread bot or group", () => {
    expect(spaceHasUnread(space({ id: "a", name: "A" }))).toBe(false);
    expect(spaceHasUnread(space({ id: "a", name: "A", bots: [unreadBot] }))).toBe(true);
    expect(spaceHasUnread(space({ id: "a", name: "A", groups: [unreadGroup] }))).toBe(true);
  });
});

describe("SpaceSwitcher", () => {
  it("names the current space and lists every space", async () => {
    await render(
      [space({ id: "a", name: "Personal", isDefault: true }), space({ id: "b", name: "Support" })],
      "b",
    );
    expect(trigger()?.textContent).toBe("Support");
    expect(container.textContent).toContain("Personal");
  });

  it("switches in place when another space is chosen, not for the current one", async () => {
    const onSwitch = vi.fn();
    await render([space({ id: "a", name: "Personal" }), space({ id: "b", name: "Support" })], "a", {
      onSwitch,
    });
    await act(async () => container.querySelector<HTMLElement>('[data-value="a"]')?.click());
    expect(onSwitch).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLElement>('[data-value="b"]')?.click());
    expect(onSwitch).toHaveBeenCalledWith("b");
  });

  it("marks the button and the space when another space has unread chats", async () => {
    await render(
      [
        space({ id: "a", name: "Personal" }),
        space({ id: "b", name: "Support", bots: [unreadBot] }),
      ],
      "a",
    );
    expect(dotsIn(trigger())).toBe(1);
    expect(dotsIn(container.querySelector('[data-value="b"]'))).toBe(1);
    expect(dotsIn(container.querySelector('[data-value="a"]'))).toBe(0);
  });

  it("ignores unread chats in the space being shown", async () => {
    await render(
      [
        space({ id: "a", name: "Personal", bots: [unreadBot] }),
        space({ id: "b", name: "Support" }),
      ],
      "a",
    );
    expect(dotsIn(container)).toBe(0);
  });

  it("switches from the mini sidebar through a button named for the space", async () => {
    await render(
      [
        space({ id: "a", name: "Personal" }),
        space({ id: "b", name: "Support", groups: [unreadGroup] }),
      ],
      "a",
      { mini: true },
    );
    expect(trigger()?.getAttribute("aria-label")).toBe("Personal");
    expect(trigger()?.textContent).toContain("P");
    expect(dotsIn(trigger())).toBe(1);
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
