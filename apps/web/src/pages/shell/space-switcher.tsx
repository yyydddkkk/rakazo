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
import { useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { selectSpace } from "../../lib/rpc";
import { DeleteItemDialog, SpaceNameDialog } from "./dialogs";

type Dialog = "new" | "rename" | "delete" | null;

/** Another space is an auth boundary: select it and reload so nothing of this one survives. */
function openSpace(spaceId: string, path = "/app") {
  if (selectSpace(spaceId)) window.location.assign(path);
}

export function SpaceSwitcher({
  rpc,
  spaces,
  currentSpaceId,
  refresh,
}: {
  rpc: RpcClient;
  spaces: Space[];
  currentSpaceId: string;
  refresh: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const current = spaces.find((space) => space.id === currentSpaceId);
  if (!current) return null;
  const close = () => setDialog(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="space-switcher"
          className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[13.5px] font-medium text-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{current.name}</span>
          <ChevronsUpDown
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuRadioGroup
            value={currentSpaceId}
            onValueChange={(id) => {
              if (id !== currentSpaceId) openSpace(id);
            }}
          >
            {spaces.map((space) => (
              <DropdownMenuRadioItem key={space.id} value={space.id}>
                <span className="truncate">{space.name}</span>
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
        <SpaceNameDialog
          onCancel={close}
          onConfirm={async (name) => {
            const space = await rpc.spaces.create({ name });
            openSpace(space.id, "/onboarding");
          }}
        />
      ) : null}
      {dialog === "rename" ? (
        <SpaceNameDialog
          space={current}
          onCancel={close}
          onConfirm={async (name) => {
            await rpc.spaces.rename({ spaceId: current.id, name });
            close();
            await refresh().catch(() => undefined);
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
            openSpace(result.activeSpaceId);
          }}
        />
      ) : null}
    </>
  );
}
