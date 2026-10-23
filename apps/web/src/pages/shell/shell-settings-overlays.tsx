import type { Bot, Me } from "@rakazo/contracts";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { Suspense } from "react";
import { lazyOverlay } from "../../components/ErrorBoundary";
import type { createSpaceRpc } from "../../lib/rpc";
import type { SettingsSection } from "../SettingsOverlay";
import { FALLBACK_BOT_COLOR } from "./chat-shared";

const SettingsOverlay = lazyOverlay(() =>
  import("../SettingsOverlay").then((module) => module.SettingsOverlay),
);
const PeerMessagesOverlay = lazyOverlay(() =>
  import("../PeerMessagesOverlay").then((module) => module.PeerMessagesOverlay),
);

export function ShellSettingsOverlays({
  rpc,
  settingsOpen,
  setSettingsOpen,
  settingsSection,
  setSettingsSection,
  setMessagingSettingsOpen,
  setMcpOpen,
  currentBotId,
  spaceName,
  userName,
  userEmail,
  usage,
  refreshUsage,
  bootstrapMe,
  setBootstrapMe,
  messagingSurfaceEnabled,
  peerConversation,
  setPeerConversation,
  active,
  resolveTranscriptBot,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsSection: SettingsSection;
  setSettingsSection: (section: SettingsSection) => void;
  setMessagingSettingsOpen: (open: boolean) => void;
  setMcpOpen: (open: boolean) => void;
  currentBotId: string | undefined;
  spaceName: string | undefined;
  userName: string;
  userEmail: string | undefined;
  usage: ComponentProps<typeof SettingsOverlay>["usage"];
  refreshUsage: () => void;
  bootstrapMe: Me | null | undefined;
  setBootstrapMe: Dispatch<SetStateAction<Me | null | undefined>>;
  messagingSurfaceEnabled: boolean;
  peerConversation: { peerBotId: string; peerBotName: string } | null;
  setPeerConversation: (peer: { peerBotId: string; peerBotName: string } | null) => void;
  active: Bot | undefined;
  resolveTranscriptBot: (botId: string) => { color?: string } | undefined;
}) {
  return (
    <Suspense fallback={null}>
      {settingsOpen ? (
        <SettingsOverlay
          spaceName={spaceName}
          name={userName}
          email={userEmail}
          usage={usage}
          onUsageOpen={refreshUsage}
          initialSection={settingsSection}
          avatarStyle={bootstrapMe?.avatarStyle ?? "organic"}
          isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
          sandboxProvider={bootstrapMe?.sandboxProvider}
          onSandboxProviderChange={(sandboxProvider) =>
            setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev))
          }
          messagingEnabled={messagingSurfaceEnabled}
          onOpenMessaging={() => {
            setSettingsOpen(false);
            setMessagingSettingsOpen(true);
          }}
          activeBotId={currentBotId}
          onOpenMcp={() => {
            setSettingsOpen(false);
            setMcpOpen(true);
          }}
          onAvatarStyleChange={async (avatarStyle) => {
            const nextMe = await rpc.preferences.update({ avatarStyle });
            // Merge only the saved field: a concurrent save's response must not be undone.
            setBootstrapMe((prev) =>
              prev ? { ...prev, avatarStyle: nextMe.avatarStyle } : nextMe,
            );
          }}
          timezone={bootstrapMe?.timezone ?? null}
          onTimezoneChange={async (timezone) => {
            const nextMe = await rpc.preferences.update({ timezone });
            setBootstrapMe((prev) => (prev ? { ...prev, timezone: nextMe.timezone } : nextMe));
          }}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsSection("general");
          }}
        />
      ) : null}
      {peerConversation && active ? (
        <PeerMessagesOverlay
          botId={active.id}
          botName={active.name}
          botColor={active.color}
          peerBotId={peerConversation.peerBotId}
          peerBotName={peerConversation.peerBotName}
          peerBotColor={
            resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
          }
          onClose={() => setPeerConversation(null)}
        />
      ) : null}
    </Suspense>
  );
}
