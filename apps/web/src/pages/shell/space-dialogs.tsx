import { Trans, useLingui } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Pencil, Settings, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { Suspense } from "react";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import { DeleteItemDialog, NewSpaceDialog, RenameSpaceDialog } from "./dialogs";
import { commitSpaceRename } from "./space-sidebar";

export function SpaceDialogs({
  rpc,
  spaces,
  setSpaces,
  spaceMenu,
  setSpaceMenu,
  newSpaceOpen,
  setNewSpaceOpen,
  renameSpaceTarget,
  setRenameSpaceTarget,
  deleteSpaceTarget,
  setDeleteSpaceTarget,
  currentSpaceId,
  isAlive,
  setPanel,
  refreshBots,
  openSpaceSettings,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  spaces: Space[];
  setSpaces: Dispatch<SetStateAction<Space[]>>;
  spaceMenu: { id: string; position: { x: number; y: number } } | null;
  setSpaceMenu: (menu: { id: string; position: { x: number; y: number } } | null) => void;
  newSpaceOpen: boolean;
  setNewSpaceOpen: (open: boolean) => void;
  renameSpaceTarget: Space | null;
  setRenameSpaceTarget: (space: Space | null) => void;
  deleteSpaceTarget: Space | null;
  setDeleteSpaceTarget: (space: Space | null) => void;
  currentSpaceId: string | undefined;
  isAlive: () => boolean;
  setPanel: (panel: Panel) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  openSpaceSettings: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  const spaceMenuTarget = spaceMenu
    ? (spaces.find((space) => space.id === spaceMenu.id) ?? null)
    : null;
  return (
    <Suspense fallback={null}>
      {spaceMenu ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) setSpaceMenu(null);
          }}
        >
          {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                className="fixed size-0 p-0 opacity-0"
                style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
              />
            }
          />
          <DropdownMenuContent
            aria-label={t`Actions for space`}
            align="start"
            sideOffset={0}
            className="w-[220px]"
          >
            {spaceMenuTarget ? (
              <DropdownMenuItem
                onClick={() => {
                  setSpaceMenu(null);
                  openSpaceSettings(spaceMenuTarget.id);
                }}
              >
                <Settings />
                {t`Settings`}
              </DropdownMenuItem>
            ) : null}
            {spaceMenuTarget?.canRename ? (
              <DropdownMenuItem
                onClick={() => {
                  setRenameSpaceTarget(spaceMenuTarget);
                  setSpaceMenu(null);
                }}
              >
                <Pencil />
                {t`Rename space`}
              </DropdownMenuItem>
            ) : null}
            {spaceMenuTarget?.canDelete ? (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setDeleteSpaceTarget(spaceMenuTarget);
                  setSpaceMenu(null);
                }}
              >
                <Trash2 />
                {t`Delete space`}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {renameSpaceTarget ? (
        <RenameSpaceDialog
          space={renameSpaceTarget}
          onCancel={() => setRenameSpaceTarget(null)}
          onConfirm={async (name) => {
            const spaceId = renameSpaceTarget.id;
            await commitSpaceRename({
              rename: async () => {
                await rpc.spaces.rename({ spaceId, name });
              },
              apply: () => {
                setSpaces((current) =>
                  current.map((space) => (space.id === spaceId ? { ...space, name } : space)),
                );
              },
              refresh: () => refreshBots(),
            });
            setRenameSpaceTarget(null);
          }}
        />
      ) : null}

      {deleteSpaceTarget ? (
        <DeleteItemDialog
          item={deleteSpaceTarget}
          noun="space"
          description={
            <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
          }
          onCancel={() => setDeleteSpaceTarget(null)}
          onConfirm={async () => {
            const targetId = deleteSpaceTarget.id;
            const result = await rpc.spaces.remove({ spaceId: targetId });
            if (!isAlive()) return;
            setDeleteSpaceTarget(null);
            setPanel(null);
            const effectiveSpaceId = selectedSpaceId() ?? currentSpaceId;
            if (effectiveSpaceId === targetId) {
              // The auth boundary changed, so reload like a space switch.
              if (selectSpace(result.activeSpaceId)) {
                window.location.assign("/app");
                return;
              }
            }
            await refreshBots(true);
          }}
        />
      ) : null}

      {newSpaceOpen ? (
        <NewSpaceDialog
          onCancel={() => setNewSpaceOpen(false)}
          onConfirm={async (name) => {
            const space = await rpc.spaces.create({ name });
            if (!isAlive()) return;
            if (!selectSpace(space.id)) {
              setNewSpaceOpen(false);
              await refreshBots();
              return;
            }
            window.location.assign("/onboarding");
          }}
        />
      ) : null}
    </Suspense>
  );
}
