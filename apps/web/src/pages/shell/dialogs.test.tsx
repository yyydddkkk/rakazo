// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
  AlertDialogCancel: (props: ComponentProps<"button">) => <button {...props} />,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { SpaceNameDialog } from "./dialogs";

let container: HTMLDivElement;
let root: Root;

async function render(
  onConfirm: (name: string) => Promise<void>,
  space?: ComponentProps<typeof SpaceNameDialog>["space"],
) {
  await act(async () => {
    root.render(<SpaceNameDialog space={space} onCancel={() => undefined} onConfirm={onConfirm} />);
  });
}

function nameField(): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing name field");
  return input;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing ${label} button`);
  return found;
}

async function type(name: string) {
  const input = nameField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string) {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
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

describe("SpaceNameDialog", () => {
  it("creates a space with the trimmed name once one is typed", async () => {
    const onConfirm = vi.fn(async () => undefined);
    await render(onConfirm);
    expect(container.textContent).toContain("New space");
    expect(button("Create").disabled).toBe(true);
    await type("  Support  ");
    await press("Create");
    expect(onConfirm).toHaveBeenCalledWith("Support");
  });

  it("renames only to a different name", async () => {
    const onConfirm = vi.fn(async () => undefined);
    await render(onConfirm, { name: "Personal" });
    expect(container.textContent).toContain("Rename space");
    expect(button("Save").disabled).toBe(true);
    await type("Support");
    await press("Save");
    expect(onConfirm).toHaveBeenCalledWith("Support");
  });

  it("falls back to the generic error when the failure message is blank", async () => {
    await render(
      async () => {
        throw new Error("   ");
      },
      { name: "Personal" },
    );
    await type("Support");
    await press("Save");
    expect(container.textContent).toContain("Could not rename space");
  });

  it("shows a non-blank failure message", async () => {
    await render(async () => {
      throw new Error("Space limit reached");
    });
    await type("Support");
    await press("Create");
    expect(container.textContent).toContain("Space limit reached");
  });
});
