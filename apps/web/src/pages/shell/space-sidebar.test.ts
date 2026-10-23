import { describe, expect, it, vi } from "vitest";
import { commitSpaceRename, sidebarGroupsForSpace } from "./space-sidebar";

function chat(id: string, name: string) {
  return {
    id,
    name,
    title: "",
    preview: "",
    pinned: false,
    sectionId: null as string | null,
    parentBotId: null,
  };
}

function space(
  options: { bots?: ReturnType<typeof chat>[]; botSections?: { id: string; name: string }[] } = {},
) {
  return {
    bots: options.bots ?? [chat("bot-1", "Chief")],
    groups: [],
    botSections: options.botSections ?? [],
  };
}

describe("sidebarGroupsForSpace", () => {
  it("lists a space without sections as one untitled list", () => {
    expect(sidebarGroupsForSpace(space(), "")).toEqual([
      expect.objectContaining({ key: "unassigned", title: null, sectionId: null }),
    ]);
  });

  it("keeps an empty section deletable when the space has no chats", () => {
    const input = space({ bots: [], botSections: [{ id: "old", name: "Old ideas" }] });
    expect(sidebarGroupsForSpace(input, "")).toEqual([
      expect.objectContaining({ key: "section:old", sectionId: "old", title: "Old ideas" }),
    ]);
    expect(sidebarGroupsForSpace(input, "Old")).toEqual([]);
  });

  it("shows nothing for an empty space without sections", () => {
    expect(sidebarGroupsForSpace(space({ bots: [] }), "")).toEqual([]);
  });

  it("retains empty section and Unassigned drop targets when not searching", () => {
    const input = space({
      bots: [{ ...chat("a", "Alpha"), sectionId: "s1" }],
      botSections: [
        { id: "s1", name: "Projects" },
        { id: "s2", name: "Empty" },
      ],
    });
    expect(sidebarGroupsForSpace(input, "").map((group) => group.key)).toEqual([
      "section:s1",
      "section:s2",
      "unassigned",
    ]);
    expect(sidebarGroupsForSpace(input, "Alpha").map((group) => group.key)).toEqual(["section:s1"]);
  });

  it("hides every list while a search matches nothing", () => {
    expect(sidebarGroupsForSpace(space(), "missing")).toEqual([]);
  });
});

describe("commitSpaceRename", () => {
  it("applies the saved name when the following refresh fails", async () => {
    const rename = vi.fn(async () => undefined);
    const apply = vi.fn();
    const refresh = vi.fn(async () => {
      throw new Error("list failed");
    });

    await expect(commitSpaceRename({ rename, apply, refresh })).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not apply a name when the rename itself fails", async () => {
    const apply = vi.fn();
    const refresh = vi.fn(async () => undefined);

    await expect(
      commitSpaceRename({
        rename: async () => {
          throw new Error("Space deletion is already in progress");
        },
        apply,
        refresh,
      }),
    ).rejects.toThrow("Space deletion is already in progress");
    expect(apply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
