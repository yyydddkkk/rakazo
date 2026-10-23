import { Trans } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronsUpDown } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { selectSpace } from "../../lib/rpc";
import { DeleteItemDialog, NewSpaceDialog, RenameSpaceDialog } from "./dialogs";
import { commitSpaceRename } from "./space-sidebar";

type Dialog = "new" | "rename" | "delete" | null;

/** Whether the space holds a chat with unread messages. */
export function spaceHasUnread(space: Pick<Space, "bots" | "groups">): boolean {
  return space.bots.some((bot) => bot.unread) || space.groups.some((group) => group.unread);
}

function UnreadDot({ className }: { className: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        data-space-unread-dot
        className={`rounded-full bg-unread ${className}`}
      />
      <span className="sr-only">
        <Trans> (unread)</Trans>
      </span>
    </>
  );
}

export function SpaceSwitcher({
  rpc,
  spaces,
  currentSpaceId,
  mini = false,
  onSwitch,
  setSpaces,
  refresh,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  spaces: Space[];
  currentSpaceId: string | null;
  mini?: boolean;
  onSwitch: (spaceId: string) => void;
  setSpaces: Dispatch<SetStateAction<Space[]>>;
  refresh: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const current = spaces.find((space) => space.id === currentSpaceId);
  if (!current) return null;
  const close = () => setDialog(null);
  const otherUnread = spaces.some((space) => space.id !== current.id && spaceHasUnread(space));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="space-switcher"
          aria-label={mini ? current.name : undefined}
          className={
            mini
              ? "relative flex size-7 items-center justify-center rounded-full bg-sidebar-accent text-[12.5px] font-semibold text-foreground outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
              : "flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[14px] font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          {mini ? (
            <span aria-hidden="true">{Array.from(current.name)[0]?.toUpperCase()}</span>
          ) : (
            <>
              <span className="truncate">{current.name}</span>
              <ChevronsUpDown
                size={13}
                strokeWidth={1.8}
                className="shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </>
          )}
          {otherUnread ? (
            <UnreadDot
              className={
                mini ? "absolute -end-0.5 -top-0.5 size-2 ring-2 ring-sidebar" : "size-2 shrink-0"
              }
            />
          ) : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuRadioGroup
            value={current.id}
            onValueChange={(id) => {
              if (id !== current.id) onSwitch(id);
            }}
          >
            {spaces.map((space) => (
              <DropdownMenuRadioItem key={space.id} value={space.id}>
                <span className="truncate">{space.name}</span>
                {space.id !== current.id && spaceHasUnread(space) ? (
                  <UnreadDot className="ms-auto size-2 shrink-0" />
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialog("new")}>
            <Trans>New space</Trans>
          </DropdownMenuItem>
          {current.canRename ? (
            <DropdownMenuItem onClick={() => setDialog("rename")}>
              <Trans>Rename space</Trans>
            </DropdownMenuItem>
          ) : null}
          {current.canDelete ? (
            <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
              <Trans>Delete space</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "new" ? (
        <NewSpaceDialog
          onCancel={close}
          onConfirm={async (name) => {
            const space = await rpc.spaces.create({ name });
            if (selectSpace(space.id)) {
              window.location.assign("/onboarding");
              return;
            }
            close();
            await refresh().catch(() => undefined);
          }}
        />
      ) : null}
      {dialog === "rename" ? (
        <RenameSpaceDialog
          space={current}
          onCancel={close}
          onConfirm={async (name) => {
            await commitSpaceRename({
              rename: async () => {
                await rpc.spaces.rename({ spaceId: current.id, name });
              },
              apply: () => {
                setSpaces((all) =>
                  all.map((space) => (space.id === current.id ? { ...space, name } : space)),
                );
              },
              refresh,
            });
            close();
          }}
        />
      ) : null}
      {dialog === "delete" ? (
        <DeleteItemDialog
          item={current}
          noun="space"
          onCancel={close}
          onConfirm={async () => {
            const result = await rpc.spaces.remove({ spaceId: current.id });
            // The shown space is gone, so reload into the one the server picked.
            if (selectSpace(result.activeSpaceId)) window.location.assign("/app");
          }}
        />
      ) : null}
    </>
  );
}
