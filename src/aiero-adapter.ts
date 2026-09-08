import { decodePackets, encodePacket } from "./protocol";
import type { Packet } from "./types";

export interface TransportChannel {
  id: string;
  displayName: string;
  url: string;
}

export type PacketHandler = (packet: Packet, channel: TransportChannel) => void;

/**
 * Same-origin DOM adapter. It deliberately uses only normal Aiero pages and UI;
 * there is no private API, cookie export or third-party relay.
 */
export class AieroDomAdapter {
  private frames = new Map<string, HTMLIFrameElement>();
  private seen = new Set<string>();
  private handlers = new Set<PacketHandler>();
  private timer?: number;

  constructor(private readonly mount: HTMLElement) {}

  onPacket(handler: PacketHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  addChannel(channel: TransportChannel): void {
    if (this.frames.has(channel.id)) return;
    const url = new URL(channel.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.includes("/chats")) throw new Error("私信链接必须属于当前域名的 /chats 页面");
    const frame = document.createElement("iframe");
    frame.dataset.channelId = channel.id;
    frame.dataset.channelName = channel.displayName;
    frame.src = url.href;
    frame.hidden = true;
    frame.title = `风月私信通道：${channel.displayName}`;
    this.mount.append(frame);
    this.frames.set(channel.id, frame);
  }

  removeChannel(id: string): void {
    this.frames.get(id)?.remove();
    this.frames.delete(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.poll(), 1200);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    for (const [id, frame] of this.frames) {
      try {
        const doc = frame.contentDocument;
        if (!doc?.body) continue;
        for (const packet of decodePackets(doc.body.innerText)) {
          if (this.seen.has(packet.id)) continue;
          this.seen.add(packet.id);
          const channel = { id, displayName: frame.dataset.channelName ?? id, url: frame.src };
          for (const handler of this.handlers) handler(packet, channel);
        }
      } catch { /* iframe is not ready or is not same-origin */ }
    }
  }

  async send(channelId: string, packet: Packet): Promise<void> {
    const frame = this.frames.get(channelId);
    const doc = frame?.contentDocument;
    if (!doc) throw new Error("私信通道尚未载入");
    const input = doc.querySelector<HTMLTextAreaElement>('textarea[placeholder*="输入消息"]');
    if (!input) throw new Error("找不到风月私信输入框，页面结构可能已经更新");
    const wire = encodePacket(packet);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, wire);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: wire }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    const area = input.closest("form") ?? input.parentElement?.parentElement ?? doc.body;
    const buttons = [...area.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const send = buttons.at(-1);
    if (!send) throw new Error("找不到可用的私信发送按钮");
    send.click();
  }
}

export function currentPrivateChatChannel(): TransportChannel | null {
  const url = new URL(location.href);
  if (!url.pathname.includes("/chats") || url.searchParams.get("type") !== "private") return null;
  const id = url.searchParams.get("uid") || url.searchParams.get("cid");
  if (!id) return null;
  return { id, displayName: url.searchParams.get("un") || id, url: url.href };
}
