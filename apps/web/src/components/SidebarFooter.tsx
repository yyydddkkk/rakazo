import { Trans, useLingui } from "@lingui/react/macro";
import { Button, buttonVariants, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import {
  BookOpen,
  FolderOpen,
  Gauge,
  LogOut,
  Settings,
  SquareKanban,
  UserRound,
} from "lucide-react";
import { useState } from "react";

type Props = {
  mini?: boolean;
  name: string;
  initials: string | null;
  image?: string | null;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBoard?: () => void;
  onArtifacts: () => void;
  onSettings: () => void;
  onUsage: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
};

export function SidebarFooter({
  mini = false,
  name,
  initials,
  image,
  email,
  open,
  onOpenChange,
  onBoard,
  onArtifacts,
  onSettings,
  onUsage,
  onLogOut,
  signingOut,
  logOutError,
}: Props) {
  const { t } = useLingui();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <div
      data-testid="sidebar-footer"
      className={`flex shrink-0 items-center gap-2 bg-transparent py-3 ${mini ? "flex-col px-1" : "px-2.5"}`}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-sidebar-accent text-sm font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image && failedImage !== image ? (
            <img
              src={image}
              alt=""
              className="size-full object-cover"
              onError={() => setFailedImage(image)}
            />
          ) : initials ? (
            initials
          ) : (
            <UserRound size={18} aria-hidden="true" />
          )}
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-sm font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-xs text-muted-foreground">{email}</p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onUsage}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href="https://github.com/elie222/rakazo/blob/main/docs/self-host.md"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Docs</Trans>
            </a>
            {onBoard ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onBoard}
              >
                <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Board</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              aria-label={t`Settings`}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-[13px] text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  );
}
