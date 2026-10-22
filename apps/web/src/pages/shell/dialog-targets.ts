import type { Bot, BotSection, Group } from "@rakazo/contracts";

export type ChatTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

export type SectionTarget = { section: BotSection; spaceId: string };
