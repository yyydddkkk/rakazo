import { groupBotsForSidebar } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  title?: string | null;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
  parentBotId?: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string }[];
};

export async function commitSpaceRename(input: {
  rename: () => Promise<void>;
  apply: () => void;
  refresh: () => Promise<void>;
}): Promise<void> {
  await input.rename();
  input.apply();
  await input.refresh().catch(() => undefined);
}

/** The shown space's bots and groups, arranged into pinned, saved-section and unassigned lists. */
export function sidebarGroupsForSpace<TBot extends SidebarChat, TGroup extends SidebarChat>(
  space: SidebarSpace<TBot, TGroup>,
  query: string,
  labels?: { pinned: string; unassigned: string },
) {
  const needle = query.toLowerCase();
  const visibleBots = space.bots.filter((bot) =>
    `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
  );
  const visibleGroups = space.groups.filter((group) =>
    `${group.name} ${group.preview ?? ""}`.toLowerCase().includes(needle),
  );
  const grouped = groupBotsForSidebar(
    [
      ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
      ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
    ].map((item) => ({
      ...item,
      id: item.chat.id,
      parentBotId: item.kind === "bot" ? (item.chat.parentBotId ?? null) : null,
      pinned: item.chat.pinned,
      sectionId: item.chat.sectionId,
    })),
    space.botSections,
    { labels },
  );
  // Keep destinations visible after their last bot is dragged out. Search
  // still hides empty lists, and spaces without sections keep their old layout.
  if (!needle && space.botSections.length > 0 && grouped.length > 0) {
    for (const section of space.botSections) {
      const key = `section:${section.id}`;
      if (!grouped.some((group) => group.key === key)) {
        grouped.push({ key, title: section.name, bots: [] });
      }
    }
    if (!grouped.some((group) => group.key === "unassigned")) {
      grouped.push({ key: "unassigned", title: labels?.unassigned ?? "Unassigned", bots: [] });
    }
    const order = [
      "pinned",
      ...space.botSections.map((section) => `section:${section.id}`),
      "unassigned",
    ];
    grouped.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  const sections = grouped.map((group) => ({
    ...group,
    sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
  }));
  if (sections.length > 0 || needle) return sections;
  // Saved sections stay listed after their last chat leaves so they can still be
  // renamed or deleted.
  return space.botSections.map((section) => ({
    key: `section:${section.id}`,
    title: section.name,
    bots: [] as (typeof sections)[number]["bots"],
    sectionId: section.id as string | null,
  }));
}
