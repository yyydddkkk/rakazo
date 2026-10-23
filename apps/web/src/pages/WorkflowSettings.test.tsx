// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowSettings } from "./WorkflowSettings";

const workflows = vi.hoisted(() => ({
  list: vi.fn(),
  getBot: vi.fn(),
  setBot: vi.fn(),
  install: vi.fn(),
  setEnabled: vi.fn(),
  updateVersion: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { workflows } }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => `${text}${i ? values[i - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />;
  const Dialog = ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null;
  return {
    Button,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Disclosure: Box,
    Dialog,
    DialogContent: Box,
    DialogTitle: Box,
    AlertDialog: Dialog,
    AlertDialogContent: Box,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: Box,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: ComponentProps<"button"> & {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
        {...props}
      />
    ),
  };
});

const entry = {
  id: "package-1",
  alias: "example",
  name: "Example workflow",
  version: "1.0.0",
  enabled: true,
  commit: "a".repeat(40),
  requestedRevision: "v1.0.0",
  url: "https://example.test/workflow.git",
  packagePath: "",
  license: "MIT",
  digest: "b".repeat(64),
  omitted: ["scripts/build.sh"],
  skills: [{ name: "review", description: "Review work", path: "skills/review/SKILL.md" }],
  agents: [{ name: "reviewer", description: "Reviews work" }],
};
const views: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  workflows.list.mockResolvedValue([entry]);
  workflows.getBot.mockResolvedValue({ packageIds: [], alwaysUse: [] });
});
afterEach(async () => {
  for (const close of views.splice(0)) await close();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(botId?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  views.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<WorkflowSettings botId={botId} isPi />));
  return container;
}
async function click(element: Element | undefined | null) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}
function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((el) => el.textContent === text);
}

it("submits fixed version and optional package path; reports an install failure", async () => {
  workflows.install.mockRejectedValue(new Error("Unavailable revision"));
  const view = await render();
  const form = view.querySelector("form")!;
  (form.elements.namedItem("url") as HTMLInputElement).value = "https://example.test/workflow.git";
  (form.elements.namedItem("revision") as HTMLInputElement).value = "v1.0.0";
  (form.elements.namedItem("packagePath") as HTMLInputElement).value = "packages/workflow";
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(workflows.install).toHaveBeenCalledWith({
    url: entry.url,
    revision: "v1.0.0",
    packagePath: "packages/workflow",
  });
  expect(view.querySelector('[role="alert"]')).toBeTruthy();
  expect((form.elements.namedItem("revision") as HTMLInputElement).value).toBe("v1.0.0");
});

it("saves bot selection and explicit always-use keys, removing keys with the package", async () => {
  const view = await render("bot-1");
  expect(view.textContent).not.toContain("Always use");
  workflows.getBot.mockResolvedValue({ packageIds: [entry.id], alwaysUse: [] });
  await click(view.querySelector('[role="switch"]'));
  expect(workflows.setBot).toHaveBeenLastCalledWith({
    botId: "bot-1",
    packageIds: [entry.id],
    alwaysUse: [],
  });
  workflows.getBot.mockResolvedValue({ packageIds: [entry.id], alwaysUse: ["example:review"] });
  await click(view.querySelectorAll('[role="switch"]')[1]);
  expect(workflows.setBot).toHaveBeenLastCalledWith({
    botId: "bot-1",
    packageIds: [entry.id],
    alwaysUse: ["example:review"],
  });
  await click(view.querySelector('[role="switch"]'));
  expect(workflows.setBot).toHaveBeenLastCalledWith({
    botId: "bot-1",
    packageIds: [],
    alwaysUse: [],
  });
  expect(view.textContent).toContain("Only skills are available with Pi.");
});

it("updates the fixed version, disables and confirms uninstall", async () => {
  const view = await render();
  const form = view.querySelectorAll("form")[1]!;
  (form.elements.namedItem("revision") as HTMLInputElement).value = "v2.0.0";
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(workflows.updateVersion).toHaveBeenCalledWith({ packageId: entry.id, revision: "v2.0.0" });
  await click(view.querySelector('[role="switch"]'));
  expect(workflows.setEnabled).toHaveBeenCalledWith({ packageId: entry.id, enabled: false });
  await click(button(view, "Uninstall"));
  expect(workflows.remove).not.toHaveBeenCalled();
  const buttons = [...view.querySelectorAll("button")].filter(
    (el) => el.textContent === "Uninstall",
  );
  await click(buttons[1]);
  expect(workflows.remove).toHaveBeenCalledWith({ packageId: entry.id });
});
