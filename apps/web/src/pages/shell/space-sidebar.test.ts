import { describe, expect, it } from "vitest";
import { sidebarGroupsForSpaces } from "./space-sidebar";

function chat(id: string, name: string) {
  return {
    id,
    name,
    title: "",
    preview: "",
    pinned: false,
    sectionId: null,
    parentBotId: null,
  };
}

function space(id: string, name: string, options: { bots?: ReturnType<typeof chat>[] } = {}) {
  return {
    id,
    name,
    bots: options.bots ?? [chat(`${id}-bot`, "Chief")],
    groups: [],
    botSections: [],
  };
}

describe("sidebarGroupsForSpaces", () => {
  it("keeps an empty section deletable when the only space has no chats", () => {
    const input = {
      ...space("space-1", "Personal", { bots: [] }),
      botSections: [{ id: "old", name: "Old ideas" }],
    };
    expect(sidebarGroupsForSpaces([input], "")).toEqual([
      expect.objectContaining({ key: "section:old", sectionId: "old", title: "Old ideas" }),
    ]);
    expect(sidebarGroupsForSpaces([input], "Old")).toEqual([]);
  });

  it("retains empty section and Unassigned drop targets when not searching", () => {
    const input = {
      ...space("space-1", "Personal"),
      bots: [{ ...chat("a", "Alpha"), sectionId: "s1" }],
      botSections: [
        { id: "s1", name: "Projects" },
        { id: "s2", name: "Empty" },
      ],
    };
    expect(sidebarGroupsForSpaces([input], "").map((group) => group.key)).toEqual([
      "section:s1",
      "section:s2",
      "unassigned",
    ]);
    expect(sidebarGroupsForSpaces([input], "Alpha").map((group) => group.key)).toEqual([
      "section:s1",
    ]);
  });

  it("does not add space chrome to the only space", () => {
    const [group] = sidebarGroupsForSpaces([space("space-1", "Personal")], "");
    expect(group?.title).toBeNull();
    expect(group?.bots).toHaveLength(1);
  });
  it("does not show an empty space placeholder", () => {
    expect(sidebarGroupsForSpaces([space("space-1", "Personal", { bots: [] })], "")).toEqual([]);
  });
});
