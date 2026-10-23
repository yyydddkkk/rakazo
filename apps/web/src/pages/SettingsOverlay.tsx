import { useLingui } from "@lingui/react/macro";
import type { AvatarStyle } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  OptionSelect,
} from "@rakazo/ui-web";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Gauge,
  Monitor,
  Settings,
  ShieldCheck,
  XIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { SpaceRpcProvider } from "../lib/space-rpc";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

export type SettingsSection =
  | "general"
  | "models"
  | "memory"
  | "confirmations"
  | "usage"
  | "computer";

/** Sections whose settings belong to a space; only these show the space picker. */
const SPACE_SECTIONS: ReadonlySet<SettingsSection> = new Set(["models", "memory", "confirmations"]);

type NavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

export function SettingsOverlay({
  space,
  spaces = [],
  onSpaceChange,
  email,
  name,
  usage,
  onUsageOpen,
  initialSection = "general",
  avatarStyle,
  onAvatarStyleChange,
  timezone,
  onTimezoneChange,
  isDeploymentOwner = false,
  sandboxProvider,
  onSandboxProviderChange,
  messagingEnabled = false,
  onOpenMessaging,
  onClose,
}: {
  /** The space the per-space sections act on; it need not be the selected space. */
  space?: { id: string; name: string } | null;
  spaces?: { id: string; name: string }[];
  onSpaceChange?: (spaceId: string) => void;
  email?: string | null;
  name: string;
  usage?: {
    runs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
  } | null;
  onUsageOpen: () => void;
  initialSection?: SettingsSection;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  timezone: string | null;
  onTimezoneChange: (timezone: string) => Promise<void>;
  isDeploymentOwner?: boolean;
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [navOverflow, setNavOverflow] = useState({ previous: false, next: false });
  const usageRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer =
    keepComputerRecovery || (isDeploymentOwner && computersAreUnavailable(sandboxProvider));
  const spaceScoped = SPACE_SECTIONS.has(section);
  const spaceId = spaceScoped ? (space?.id ?? null) : null;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (!showComputer && section === "computer") setSection("general");
  }, [showComputer, section]);

  useEffect(() => {
    if (section !== "computer") releaseComputerRecovery();
  }, [section, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);

  useEffect(() => {
    if (section === "usage") {
      onUsageOpen();
      usageRef.current?.focus();
    }
  }, [section, onUsageOpen]);

  const navItems: NavItem[] = [
    { id: "general", label: t`General`, icon: Settings },
    { id: "models", label: t`Models`, icon: Cpu },
    { id: "memory", label: t`Memory`, icon: Brain },
    { id: "confirmations", label: t`Confirmations`, icon: ShieldCheck },
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(showComputer ? [{ id: "computer" as const, label: t`Computer`, icon: Monitor }] : []),
  ];

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const offset = Math.abs(nav.scrollLeft);
      setNavOverflow({
        previous: offset > 1,
        next: nav.scrollWidth - nav.clientWidth - offset > 1,
      });
    };
    const revealSection = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }
      measure();
    };
    revealSection();
    nav.addEventListener("scroll", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSection);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [section, showComputer, i18n.locale]);

  function scrollSections(direction: number) {
    const nav = navRef.current;
    if (!nav) return;
    const rtl = getComputedStyle(nav).direction === "rtl";
    nav.scrollBy({ left: nav.clientWidth * 0.75 * direction * (rtl ? -1 : 1), behavior: "smooth" });
  }

  const sectionTitle =
    navItems.find((item) => item.id === section)?.label ??
    (section === "general" ? t`General` : t`Settings`);

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : t`Close user settings`;

  const requestClose = onClose;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 md:contents">
            {/* Reserve arrow space so showing controls does not change the overflow measurement. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Previous settings sections`}
              disabled={!navOverflow.previous}
              onClick={() => scrollSections(-1)}
            >
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <nav
              ref={navRef}
              data-testid="settings-nav"
              aria-label={t`Settings`}
              className="flex min-w-0 flex-1 flex-row gap-1 overflow-x-auto py-3 md:w-[200px] md:shrink-0 md:flex-none md:flex-col md:overflow-y-auto md:border-e md:border-border md:px-3 md:py-4"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === section;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`settings-nav-${item.id}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setSection(item.id)}
                    className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Next settings sections`}
              disabled={!navOverflow.next}
              onClick={() => scrollSections(1)}
            >
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              data-testid="settings-header"
              className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pb-5 pt-6 sm:px-8 sm:pt-7"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <DialogTitle className="text-2xl font-medium text-foreground">
                  {sectionTitle}
                </DialogTitle>
                {!spaceScoped ? null : space && spaces.length > 1 && onSpaceChange ? (
                  <OptionSelect
                    className="w-56"
                    data-testid="settings-space"
                    aria-label={t`Space`}
                    options={spaces.map((option) => ({ value: option.id, label: option.name }))}
                    value={space.id}
                    onValueChange={(next) => {
                      if (next !== space.id) onSpaceChange(next);
                    }}
                  />
                ) : space ? (
                  <p data-testid="settings-space" className="text-sm text-muted-foreground">
                    {space.name}
                  </p>
                ) : null}
              </div>
              <DialogClose
                aria-label={closeLabel}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <SpaceRpcProvider spaceId={spaceId}>
              <div
                key={spaceId ?? "selected"}
                data-testid="settings-scroll"
                className={`min-h-0 flex-1 ${
                  section === "models" || section === "memory"
                    ? "flex flex-col overflow-hidden"
                    : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8"
                }`}
              >
                {section === "general" ? (
                  <GeneralSettingsPanels
                    email={email}
                    name={name}
                    avatarStyle={avatarStyle}
                    onAvatarStyleChange={onAvatarStyleChange}
                    timezone={timezone}
                    onTimezoneChange={onTimezoneChange}
                    messagingEnabled={messagingEnabled}
                    onOpenMessaging={onOpenMessaging}
                  />
                ) : null}
                {section === "confirmations" ? <ApprovalRulesSettings /> : null}
                {section === "usage" ? (
                  <UsageSettingsPanel usage={usage} panelRef={usageRef} />
                ) : null}
                {section === "computer" && showComputer ? (
                  <ComputerSettingsPanel
                    sandboxProvider={sandboxProvider}
                    onSandboxProviderChange={(next) => {
                      onSandboxProviderChange?.(next);
                      holdComputerRecovery();
                    }}
                    onRecoveryDismissed={releaseComputerRecovery}
                  />
                ) : null}
                {section === "models" ? (
                  <ModelSettingsOverlay embedded onClose={requestClose} />
                ) : null}
                {section === "memory" ? (
                  <MemorySettingsOverlay embedded onClose={requestClose} />
                ) : null}
              </div>
            </SpaceRpcProvider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
