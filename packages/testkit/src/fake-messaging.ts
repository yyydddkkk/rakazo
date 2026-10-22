import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSurface,
} from "@rakazo/adapter-kit";

/** Private transport fixture for provider-neutral persistence and delivery tests. */
export class FakeMessagingSurface implements MessagingSurface {
  readonly provider = "fixture";
  readonly sent: Array<{ threadId: string; body: string; handle: string }> = [];
  private sink?: (event: MessagingInboundEvent) => Promise<void>;
  private sequence = 0;

  describe(): AdapterDescriptor<{ providers: string[] }> {
    return {
      id: "fake-messaging",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { providers: [this.provider] },
    };
  }
  platforms(): MessagingPlatformDescriptor[] {
    return [
      { provider: this.provider, capabilities: { direct: true, groups: true, receipt: null } },
    ];
  }
  handleWebhook(): null {
    return null;
  }
  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>) {
    this.sink = sink;
  }
  async emitInbound(
    input: Partial<MessagingInboundMessage> & { content: string },
  ): Promise<MessagingInboundMessage> {
    if (!this.sink) throw new Error("Fixture messaging sink is not connected");
    const event: MessagingInboundMessage = {
      type: "message",
      threadId: `${this.provider}:dm:${input.from ?? "sender"}`,
      isDirect: true,
      from: "sender",
      fromLabel: "Fixture User",
      channelName: null,
      participants: [],
      mediaUrl: null,
      ...input,
      provider: this.provider,
      handle: input.handle ?? `inbound-${++this.sequence}`,
    };
    await this.sink(event);
    return event;
  }
  async sendToThread(request: MessagingSendRequest, _context: AdapterContext) {
    if (!request.threadId.startsWith(`${this.provider}:`))
      throw new Error("Unknown fixture messaging thread");
    const handle = `outbound-${++this.sequence}`;
    this.sent.push({ threadId: request.threadId, body: request.body, handle });
    return { handle };
  }
  async openDirectThread(provider: string, address: string, _context: AdapterContext) {
    if (provider !== this.provider) throw new Error("Unknown fixture messaging provider");
    return `${provider}:dm:${address}`;
  }
  async acknowledge() {}
  resetWitnesses() {
    this.sent.length = 0;
  }
}
