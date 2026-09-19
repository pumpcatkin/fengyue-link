import { AieroDomAdapter, currentPrivateChatChannel, type TransportChannel } from "./aiero-adapter";
import { fetchDomains, testDomains } from "./domain-service";
import { createPacket, derivePasswordVerifier, makeId, makeJoinProof } from "./protocol";
import { loadState, saveState } from "./store";
import { styles } from "./styles";
import type { AppState, DomainCandidate, Packet, RoomMember } from "./types";

const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

export class FengyueLinkApp {
  private state: AppState = loadState();
  private domains: DomainCandidate[] = [];
  private root: ShadowRoot;
  private transport: AieroDomAdapter;
  private seq = 0;
  private logs: string[] = [];
  private pendingChallenges = new Map<string, { challenge: string; profile: RoomMember; channel: TransportChannel }>();
  private turnInputs = new Map<number, Map<string, { displayName: string; text: string }>>();

  constructor() {
    const host = document.createElement("div");
    host.id = "fengyue-link-root";
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: "open" });
    const desktop = Boolean(window.fengyueDesktop);
    this.root.innerHTML = `<style>${styles}</style><button class="fab" title="打开风月联机工具">联</button><div class="shell ${desktop ? "" : "hidden"}"></div><div id="transport-mount"></div>`;
    this.transport = new AieroDomAdapter(this.root.querySelector("#transport-mount") as HTMLElement);
    this.transport.onPacket((packet, channel) => void this.handlePacket(packet, channel));
    this.transport.start();
    const current = currentPrivateChatChannel();
    if (current) this.transport.addChannel(current);
    this.bindGlobal();
    this.render();
    window.setInterval(() => this.updateStatusBadge(), 1500);
  }

  private bindGlobal(): void {
    this.root.querySelector(".fab")?.addEventListener("click", () => {
      this.root.querySelector(".shell")?.classList.toggle("hidden");
    });
  }

  private persist(): void { saveState(this.state); }
  private log(message: string): void { this.logs.unshift(`${new Date().toLocaleTimeString()}  ${message}`); this.logs = this.logs.slice(0, 80); this.render(); }

  private isLoggedIn(): boolean {
    const body = document.body.innerText;
    const loginVisible = [...document.querySelectorAll("button,a")].some(el => /^(登录|注册)$/.test(el.textContent?.trim() ?? ""));
    const guestMode = /\bGuest\b/.test(body) && /暂无私信|请选择一个会话/.test(body);
    const accountEvidence = /积分[:：]/.test(body) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(body);
    return !loginVisible && !guestMode && accountEvidence;
  }

  private updateStatusBadge(): void {
    const badge = this.root.querySelector<HTMLElement>("#login-status");
    if (badge) badge.textContent = this.isLoggedIn() ? "● 已识别登录态" : "○ 请先在程序内登录";
  }

  private captureWork(): { suffix: string; title: string } | null {
    const match = location.pathname.match(/\/(?:zh\/)?explore\/installed\/[^/?#]+/);
    if (!match) return null;
    return { suffix: `${match[0]}${location.search}`, title: document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*-\s*(Powered by )?AI风月.*/, "") };
  }

  private render(): void {
    const shell = this.root.querySelector<HTMLElement>(".shell");
    if (!shell) return;
    const mobileClosed = shell.querySelector(".side")?.classList.contains("mobile-closed") ?? false;
    shell.innerHTML = `
      <aside class="side ${mobileClosed ? "mobile-closed" : ""}">
        <div class="brand"><span class="logo">联</span><span><strong>风月联机</strong><small>私信传输 · 零自建后端</small></span><button class="close" data-action="close">×</button></div>
        <nav class="nav"><button class="active" data-tab="room">房间</button><button data-tab="members">成员</button><button data-tab="domains">节点</button></nav>
        <section class="panel active" data-panel="room">${this.roomPanel()}</section>
        <section class="panel" data-panel="members">${this.membersPanel()}</section>
        <section class="panel" data-panel="domains">${this.domainPanel()}</section>
      </aside>
      <main class="main">
        <header class="topbar"><button class="btn" data-action="mobile-menu">☰</button><span class="pill" id="login-status">${this.isLoggedIn() ? "● 已识别登录态" : "○ 请先在程序内登录"}</span><span class="pill">${esc(this.state.room.workTitle)}</span><span class="pill">第 ${this.state.room.round} 轮</span></header>
        <section class="viewport"><div class="viewport-slot">${this.viewport()}</div></section>
        <footer class="composer"><textarea id="turn-input" placeholder="请输入文本；需房间成员全体点击确认。"></textarea><button class="btn primary" data-action="confirm-turn">确认本轮输入</button></footer>
      </main>`;
    this.bindRendered();
  }

  private roomPanel(): string {
    if (this.state.room.phase !== "idle") {
      return `<div class="stack"><div class="card"><h3>${this.state.room.role === "host" ? "你是房主" : "已加入房间"}</h3><div class="muted">房间 ${esc(this.state.room.roomId)}</div><div class="muted">房主 ${esc(this.state.room.hostName)}</div><div class="muted">状态 ${esc(this.state.room.phase)}</div></div>${this.state.room.role === "host" && this.state.room.phase === "lobby" ? '<button class="btn primary" data-action="start-game">锁定成员并开始</button>' : ""}<button class="btn danger" data-action="leave-room">退出本地房间</button><div class="log">${this.logs.map(esc).join("<br>") || "等待协议消息…"}</div></div>`;
    }
    return `<div class="notice">初版使用“私信会话链接”建立通道。平台当前页面没有可见的按用户名发起私信入口，所以首次联系仍需先在风月中打开对方私信；已有私信后可完全自动传输。</div>
      <div class="field"><label>平台用户名</label><input id="platform-name" value="${esc(this.state.profile.platformName)}" placeholder="你的风月用户名"></div>
      <div class="field"><label>游戏内设定姓名</label><input id="display-name" value="${esc(this.state.profile.displayName)}" placeholder="本局使用的姓名"></div>
      <div class="field"><label>基础设定</label><textarea id="profile-basic-info" placeholder="身份、经历、性格、能力等">${esc(this.state.profile.basicInfo || this.state.profile.info)}</textarea></div>
      <div class="field"><label>外观设定</label><textarea id="profile-appearance" placeholder="发型、五官、服装、显著特征等">${esc(this.state.profile.appearance)}</textarea></div>
      <div class="row"><button class="btn primary" data-action="show-create">创建房间</button><button class="btn" data-action="show-join">加入房间</button></div>
      <div id="mode-fields" class="stack"></div>`;
  }

  private membersPanel(): string {
    if (!this.state.room.members.length) return '<div class="empty"><span><strong>还没有成员</strong>创建或加入房间后显示成员与准备状态</span></div>';
    return `<div class="stack">${this.state.room.members.map(member => this.memberCard(member)).join("")}</div>`;
  }

  private memberCard(member: RoomMember): string {
    return `<div class="card member"><span class="avatar">${esc(member.displayName.slice(0, 1) || "?")}</span><span class="meta"><b>${esc(member.displayName)}</b><small>${esc(member.platformName)} · ${esc(member.info || "未填写资料")}</small></span><span class="status"><i class="dot ${member.status}"></i>${esc(member.status)}</span></div>`;
  }

  private domainPanel(): string {
    const items = this.domains.length ? this.domains.map(domain => `<div class="card domain"><span><b>${esc(domain.label)}</b><code>${esc(domain.origin)}</code></span><button class="btn" data-origin="${esc(domain.origin)}">${domain.status === "online" || domain.status === "slow" ? `${domain.latencyMs}ms` : domain.status}</button></div>`).join("") : '<div class="muted">点击后从两个官方发布页合并备用域名并并发测速。</div>';
    return `<div class="stack"><button class="btn primary" data-action="scan-domains">获取并测试全部节点</button>${items}</div>`;
  }

  private viewport(): string {
    const container = document.querySelector<HTMLElement>(".chat-container");
    if (container) return '<div class="notice">已检测到作品 chat-container。关闭联机面板后，原作品画面仍在页面中；正式版会将它无损迁入此视窗。</div>';
    return '<div class="empty"><span><strong>等待载入作品</strong>房主在作品页点击“采用当前作品”，或加入房间后等待房主开始</span></div>';
  }

  private saveProfileFields(): boolean {
    const platformName = this.value("platform-name").trim();
    const displayName = this.value("display-name").trim();
    const basicInfo = this.value("profile-basic-info").trim();
    const appearance = this.value("profile-appearance").trim();
    const info = [basicInfo ? `【基础设定】\n${basicInfo}` : "", appearance ? `【外观设定】\n${appearance}` : ""].filter(Boolean).join("\n\n");
    if (!platformName || !displayName) { this.log("请先填写平台用户名和游戏内设定姓名"); return false; }
    this.state.profile = { ...this.state.profile, platformName, displayName, basicInfo, appearance, info };
    this.persist();
    return true;
  }

  private value(id: string): string { return this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)?.value ?? ""; }

  private bindRendered(): void {
    this.root.querySelectorAll<HTMLElement>("[data-tab]").forEach(button => button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      this.root.querySelectorAll("[data-tab]").forEach(el => el.classList.toggle("active", el === button));
      this.root.querySelectorAll<HTMLElement>("[data-panel]").forEach(el => el.classList.toggle("active", el.dataset.panel === tab));
    }));
    this.root.querySelector('[data-action="close"]')?.addEventListener("click", () => this.root.querySelector(".shell")?.classList.add("hidden"));
    this.root.querySelector('[data-action="mobile-menu"]')?.addEventListener("click", () => this.root.querySelector(".side")?.classList.toggle("mobile-closed"));
    this.root.querySelector('[data-action="show-create"]')?.addEventListener("click", () => this.showCreate());
    this.root.querySelector('[data-action="show-join"]')?.addEventListener("click", () => this.showJoin());
    this.root.querySelector('[data-action="scan-domains"]')?.addEventListener("click", () => void this.scanDomains());
    this.root.querySelector('[data-action="start-game"]')?.addEventListener("click", () => void this.startGame());
    this.root.querySelector('[data-action="leave-room"]')?.addEventListener("click", () => this.leaveRoom());
    this.root.querySelector('[data-action="confirm-turn"]')?.addEventListener("click", () => void this.confirmTurn());
    this.root.querySelectorAll<HTMLElement>("[data-origin]").forEach(button => button.addEventListener("click", () => this.selectOrigin(button.dataset.origin ?? "")));
  }

  private showCreate(): void {
    if (!this.saveProfileFields()) return;
    const work = this.captureWork();
    const mount = this.root.querySelector("#mode-fields");
    if (mount) mount.innerHTML = `<div class="field"><label>房间密码</label><input id="room-password" type="password" autocomplete="new-password"></div><div class="field"><label>作品网址后缀</label><input id="work-suffix" value="${esc(work?.suffix ?? "")}" placeholder="/zh/explore/installed/..."></div><div class="field"><label>作品名</label><input id="work-title" value="${esc(work?.title ?? "")}"></div><button class="btn primary" data-action="create-room">确认创建</button>`;
    this.root.querySelector('[data-action="create-room"]')?.addEventListener("click", () => void this.createRoom());
  }

  private showJoin(): void {
    if (!this.saveProfileFields()) return;
    const current = currentPrivateChatChannel();
    const mount = this.root.querySelector("#mode-fields");
    if (mount) mount.innerHTML = `<div class="field"><label>房主风月用户名</label><input id="host-name" placeholder="房主用户名"></div><div class="field"><label>房间密码</label><input id="join-password" type="password"></div><div class="field"><label>与房主的私信链接</label><input id="host-chat-url" value="${esc(current?.url ?? "")}" placeholder="https://当前域名/zh/chats?type=private&..."></div><button class="btn primary" data-action="join-room">发送加入请求</button>`;
    this.root.querySelector('[data-action="join-room"]')?.addEventListener("click", () => void this.joinRoom());
  }

  private async createRoom(): Promise<void> {
    const password = this.value("room-password");
    const suffix = this.value("work-suffix").trim();
    if (!password || !suffix.startsWith("/")) { this.log("房间密码不能为空，作品必须是网址后缀"); return; }
    const roomId = makeId().slice(0, 8);
    this.state.room = { roomId, role: "host", phase: "lobby", hostName: this.state.profile.platformName, workSuffix: suffix, workTitle: this.value("work-title").trim() || "未命名作品", round: 0, passwordVerifier: await derivePasswordVerifier(this.state.profile.platformName, password), members: [{ ...this.state.profile, status: "online" }] };
    this.persist(); this.log(`房间 ${roomId} 已创建`);
  }

  private async joinRoom(): Promise<void> {
    const hostName = this.value("host-name").trim();
    const password = this.value("join-password");
    const channelUrl = this.value("host-chat-url").trim();
    if (!hostName || !password || !channelUrl) { this.log("请填写房主名、密码和私信链接"); return; }
    let channel;
    try { channel = { id: "host", displayName: hostName, url: channelUrl }; this.transport.addChannel(channel); } catch (error) { this.log(error instanceof Error ? error.message : "私信链接无效"); return; }
    const verifier = await derivePasswordVerifier(hostName, password);
    this.state.room = { roomId: "pending", role: "guest", phase: "lobby", hostName, workSuffix: "", workTitle: "等待房主同步作品", round: 0, passwordVerifier: verifier, members: [{ ...this.state.profile, status: "online", channelUrl }] };
    this.persist();
    const packet = createPacket("hello", "pending", this.state.profile.id, ++this.seq, { profile: this.state.profile });
    try { await this.transport.send("host", packet); this.log("加入请求已通过风月私信发送"); } catch (error) { this.log(error instanceof Error ? error.message : "发送加入请求失败"); }
  }

  private async startGame(): Promise<void> {
    if (this.state.room.role !== "host") return;
    this.state.room.phase = "playing"; this.state.room.round = 1; this.persist();
    const packet = createPacket("game-start", this.state.room.roomId, this.state.profile.id, ++this.seq, { workSuffix: this.state.room.workSuffix, workTitle: this.state.room.workTitle, members: this.state.room.members, round: 1 });
    await this.broadcast(packet); this.log("成员名单已锁定，游戏开始");
  }

  private async confirmTurn(): Promise<void> {
    const text = this.value("turn-input").trim();
    if (!text || this.state.room.phase !== "playing") { this.log("当前不在游戏中，或本轮输入为空"); return; }
    if (this.state.room.role === "guest") {
      const packet = createPacket("turn-submit", this.state.room.roomId, this.state.profile.id, ++this.seq, { round: this.state.room.round, displayName: this.state.profile.displayName, text });
      try { await this.transport.send("host", packet); this.log("本轮输入已发送给房主"); } catch (error) { this.log(error instanceof Error ? error.message : "本轮输入发送失败"); }
    } else {
      this.recordTurnInput(this.state.profile.id, this.state.profile.displayName, text, this.state.room.round);
      await this.publishTurnState();
      this.log("已记录房主本轮输入；等待其他成员");
    }
  }

  private async broadcast(packet: Packet): Promise<void> {
    const guests = this.state.room.members.filter(member => member.id !== this.state.profile.id && member.channelUrl);
    await Promise.allSettled(guests.map(member => this.transport.send(member.id, packet)));
  }

  private async handlePacket(packet: Packet, channel: TransportChannel): Promise<void> {
    this.log(`收到 ${channel.displayName} 的 ${packet.type} 消息`);
    if (packet.type === "hello" && this.state.room.role === "host" && this.state.room.phase === "lobby") {
      const payload = packet.payload as { profile?: RoomMember };
      if (!payload.profile?.id || !payload.profile.displayName) return;
      const challenge = makeId();
      this.pendingChallenges.set(packet.from, { challenge, profile: { ...payload.profile, status: "waiting" }, channel });
      await this.transport.send(channel.id, createPacket("challenge", this.state.room.roomId, this.state.profile.id, ++this.seq, { challenge }));
      this.log(`已向 ${payload.profile.displayName} 发送密码挑战`);
      return;
    }
    if (packet.type === "challenge" && this.state.room.role === "guest") {
      const payload = packet.payload as { challenge?: string };
      if (!payload.challenge || !this.state.room.passwordVerifier) return;
      const profileJson = JSON.stringify(this.state.profile);
      const proof = await makeJoinProof(this.state.room.passwordVerifier, packet.roomId, payload.challenge, profileJson);
      await this.transport.send("host", createPacket("join-proof", packet.roomId, this.state.profile.id, ++this.seq, { challenge: payload.challenge, profile: this.state.profile, proof }));
      this.log("已回应房主的密码挑战");
      return;
    }
    if (packet.type === "join-proof" && this.state.room.role === "host" && this.state.room.phase === "lobby") {
      const payload = packet.payload as { challenge?: string; profile?: RoomMember; proof?: string };
      const pending = this.pendingChallenges.get(packet.from);
      if (!pending || !payload.profile || payload.challenge !== pending.challenge || !this.state.room.passwordVerifier) return;
      const expected = await makeJoinProof(this.state.room.passwordVerifier, this.state.room.roomId, pending.challenge, JSON.stringify(payload.profile));
      if (payload.proof !== expected) {
        await this.transport.send(pending.channel.id, createPacket("error", this.state.room.roomId, this.state.profile.id, ++this.seq, { code: "AUTH_FAILED", message: "房间密码错误" }));
        this.log(`${payload.profile.displayName} 的房间密码校验失败`);
        return;
      }
      const member: RoomMember = { ...payload.profile, status: "online", channelUrl: pending.channel.url };
      this.transport.addChannel({ id: member.id, displayName: member.displayName, url: pending.channel.url });
      this.state.room.members = [...this.state.room.members.filter(item => item.id !== member.id), member];
      this.pendingChallenges.delete(packet.from);
      this.persist();
      await this.transport.send(pending.channel.id, createPacket("join-accept", this.state.room.roomId, this.state.profile.id, ++this.seq, { workSuffix: this.state.room.workSuffix, workTitle: this.state.room.workTitle, members: this.state.room.members }));
      await this.broadcast(createPacket("roster", this.state.room.roomId, this.state.profile.id, ++this.seq, { members: this.state.room.members }));
      this.log(`${member.displayName} 已通过认证并加入房间`);
      return;
    }
    if (packet.type === "join-accept" && this.state.room.role === "guest") {
      const payload = packet.payload as { workSuffix: string; workTitle: string; members: RoomMember[] };
      this.state.room = { ...this.state.room, roomId: packet.roomId, workSuffix: payload.workSuffix, workTitle: payload.workTitle, members: payload.members };
      this.persist(); this.log("房主已接受加入请求"); return;
    }
    if (packet.type === "roster") {
      const payload = packet.payload as { members?: RoomMember[] };
      if (payload.members) { this.state.room.members = payload.members; this.persist(); }
      return;
    }
    if (packet.type === "turn-submit" && this.state.room.role === "host" && this.state.room.phase === "playing") {
      const payload = packet.payload as { round: number; displayName: string; text: string };
      if (payload.round !== this.state.room.round) return;
      this.recordTurnInput(packet.from, payload.displayName, payload.text, payload.round);
      await this.publishTurnState();
      return;
    }
    if (packet.type === "turn-state") {
      const payload = packet.payload as { readyIds?: string[]; round?: number };
      if (payload.round === this.state.room.round && payload.readyIds) {
        const ready = new Set(payload.readyIds);
        this.state.room.members = this.state.room.members.map(member => ({ ...member, status: ready.has(member.id) ? "ready" : "waiting" }));
        this.persist();
      }
      return;
    }
    if (packet.type === "error") {
      const payload = packet.payload as { message?: string };
      this.log(payload.message || "房主返回了错误"); return;
    }
    if (packet.type === "game-start" && this.state.room.role === "guest") {
      const payload = packet.payload as { workSuffix: string; workTitle: string; members: RoomMember[]; round: number };
      this.state.room = { ...this.state.room, roomId: packet.roomId, phase: "playing", workSuffix: payload.workSuffix, workTitle: payload.workTitle, members: payload.members, round: payload.round };
      this.persist();
    }
  }

  private recordTurnInput(playerId: string, displayName: string, text: string, round: number): void {
    const inputs = this.turnInputs.get(round) ?? new Map<string, { displayName: string; text: string }>();
    inputs.set(playerId, { displayName, text });
    this.turnInputs.set(round, inputs);
    this.state.room.members = this.state.room.members.map(member => ({ ...member, status: inputs.has(member.id) ? "ready" : "waiting" }));
    this.persist();
  }

  private async publishTurnState(): Promise<void> {
    const inputs = this.turnInputs.get(this.state.room.round) ?? new Map();
    const readyIds = [...inputs.keys()];
    await this.broadcast(createPacket("turn-state", this.state.room.roomId, this.state.profile.id, ++this.seq, { round: this.state.room.round, readyIds }));
    if (this.state.room.members.length > 0 && this.state.room.members.every(member => inputs.has(member.id))) {
      const merged = this.state.room.members.map(member => ({ playerId: member.id, displayName: member.displayName, text: inputs.get(member.id)?.text ?? "" }));
      this.log(`第 ${this.state.room.round} 轮全员已确认：${JSON.stringify(merged)}`);
    }
  }

  private leaveRoom(): void {
    this.state.room = { roomId: "", role: null, phase: "idle", hostName: "", workSuffix: "", workTitle: "尚未选择作品", members: [], round: 0 };
    this.persist(); this.log("已退出本地房间状态");
  }

  private async scanDomains(): Promise<void> {
    this.log("正在从域名目录获取节点…");
    try {
      this.domains = (await fetchDomains()).map(item => ({ ...item, status: "testing" })); this.render();
      this.domains = await testDomains(this.domains, value => { const index = this.domains.findIndex(item => item.origin === value.origin); if (index >= 0) this.domains[index] = value; this.render(); });
      this.log(`节点测试完成：${this.domains.filter(item => item.status !== "offline").length}/${this.domains.length} 可连接`);
    } catch (error) { this.log(error instanceof Error ? error.message : "获取节点失败"); }
  }

  private selectOrigin(origin: string): void {
    const domain = this.domains.find(item => item.origin === origin);
    if (!domain || domain.status === "offline") { this.log("该节点当前不可连接"); return; }
    this.state.selectedOrigin = origin; this.persist();
    const target = new URL(location.href); target.protocol = new URL(origin).protocol; target.host = new URL(origin).host;
    location.href = target.href;
  }
}
