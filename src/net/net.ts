// PeerJS star-topology transport. Host = Peer 'afg-<CODE>'; clients open two DataConnections to it:
// label 'r' (reliable, JSON) and label 'u' (unreliable, JSON) for high-rate car messages.
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { NetCarState, NetMessage } from '../types';
import { generateRoomCode, normaliseRoomCode, peerIdForCode } from './codes';

export { generateRoomCode, normaliseRoomCode, isValidRoomCode, peerIdForCode } from './codes';

export type NetHandler = (msg: NetMessage, from: string) => void;
export type ChannelKind = 'r' | 'u';

const PING_INTERVAL_MS = 2000;
const TIMEOUT_MS = 8000;
const UNRELIABLE_WAIT_MS = 3000;
const JOIN_TIMEOUT_MS = 15000;
const HOST_RETRIES = 5;

const PEER_OPTIONS = {
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

// ------------------------------------------------------------ pure helpers (tested)

/** Which channel a message type travels on. */
export function channelFor(type: string): ChannelKind {
  return type === 'car' || type === 'cars' ? 'u' : 'r';
}

/** Host relay: a client's 'car' message is forwarded to every other client. Others are not relayed. */
export function relayTargets(msg: NetMessage, from: string, clients: readonly string[]): string[] {
  if (msg.type !== 'car') return [];
  return clients.filter((id) => id !== from);
}

/** Destination peers for an outgoing message. Client: always the host. Host: `to` or all clients. */
export function sendTargets(isHost: boolean, peers: readonly string[], to?: string): string[] {
  if (!isHost) return peers.length ? [peers[0]] : [];
  if (to !== undefined) return peers.includes(to) ? [to] : [];
  return [...peers];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Round a car state to 3 decimals for the wire (keeps JSON well under 300 bytes). */
export function packCar(s: NetCarState): NetCarState {
  return {
    id: s.id,
    t: Math.round(s.t),
    p: [r3(s.p[0]), r3(s.p[1]), r3(s.p[2])],
    q: [r3(s.q[0]), r3(s.q[1]), r3(s.q[2]), r3(s.q[3])],
    v: [r3(s.v[0]), r3(s.v[1]), r3(s.v[2])],
    steer: r3(s.steer),
    speedKmh: Math.round(s.speedKmh * 10) / 10,
    gear: s.gear,
    brake: r3(s.brake),
    compound: s.compound,
    inPit: s.inPit,
  };
}

/** Defensive copy of a received car state (sanitises missing / non-finite numbers). */
export function unpackCar(w: NetCarState): NetCarState {
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const a = (x: unknown, len: number): number[] => {
    const arr = Array.isArray(x) ? x : [];
    return Array.from({ length: len }, (_, i) => n(arr[i]));
  };
  return {
    id: String(w.id),
    t: n(w.t),
    p: a(w.p, 3) as [number, number, number],
    q: a(w.q, 4) as [number, number, number, number],
    v: a(w.v, 3) as [number, number, number],
    steer: n(w.steer),
    speedKmh: n(w.speedKmh),
    gear: n(w.gear),
    brake: n(w.brake),
    compound: w.compound,
    inPit: !!w.inPit,
  };
}

function packMessage(msg: NetMessage): NetMessage {
  if (msg.type === 'car') return { type: 'car', state: packCar(msg.state) };
  if (msg.type === 'cars') return { type: 'cars', states: msg.states.map(packCar) };
  return msg;
}

function unpackMessage(msg: NetMessage): NetMessage {
  if (msg.type === 'car' && msg.state) return { type: 'car', state: unpackCar(msg.state) };
  if (msg.type === 'cars' && Array.isArray(msg.states)) return { type: 'cars', states: msg.states.map(unpackCar) };
  return msg;
}

type Ping = { type: '__ping' | '__pong'; t: number };

interface Link {
  r: DataConnection | null;
  u: DataConnection | null;
  lastSeen: number;
  rtt: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------ session

export class NetSession {
  readonly isHost: boolean;
  code = '';
  selfId = '';
  private peer: Peer;
  private links = new Map<string, Link>();
  private handlers: NetHandler[] = [];
  private peerHandlers: Array<(peers: string[]) => void> = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private unreliableOk = true;

  private constructor(peer: Peer, isHost: boolean) {
    this.peer = peer;
    this.isHost = isHost;
  }

  /** Host: connected client ids. Client: [hostId] while connected, [] after host loss. */
  get peers(): string[] {
    const out: string[] = [];
    for (const [id, l] of this.links) if (l.r && l.r.open) out.push(id);
    return out;
  }

  static host(_name: string): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attempt = (): void => {
        attempts++;
        const code = generateRoomCode();
        const peer = new Peer(peerIdForCode(code), PEER_OPTIONS);
        let settled = false;
        peer.on('open', (id) => {
          settled = true;
          const s = new NetSession(peer, true);
          s.code = code;
          s.selfId = id;
          s.init();
          peer.on('connection', (c) => s.onIncoming(c));
          resolve(s);
        });
        peer.on('error', (err: { type?: string }) => {
          if (settled) return;
          settled = true;
          try { peer.destroy(); } catch { /* ignore */ }
          if (err.type === 'unavailable-id' && attempts < HOST_RETRIES) { attempt(); return; }
          reject(new Error(err.type === 'unavailable-id' ? 'Could not allocate a room code' : 'Could not reach the matchmaking server'));
        });
      };
      attempt();
    });
  }

  static join(codeInput: string, _name: string): Promise<NetSession> {
    const code = normaliseRoomCode(codeInput);
    return new Promise((resolve, reject) => {
      const myId = 'afgc-' + generateRoomCode() + generateRoomCode();
      const hostId = peerIdForCode(code);
      const peer = new Peer(myId, PEER_OPTIONS);
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = (msg: string): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        reject(new Error(msg));
      };
      timer = setTimeout(() => fail('Could not connect'), JOIN_TIMEOUT_MS);
      peer.on('error', (err: { type?: string }) => {
        fail(err.type === 'peer-unavailable' ? 'Room not found' : 'Could not connect');
      });
      peer.on('open', (id) => {
        const r = peer.connect(hostId, { reliable: true, serialization: 'json', label: 'r' });
        const u = peer.connect(hostId, { reliable: false, serialization: 'json', label: 'u' });
        const s = new NetSession(peer, false);
        s.code = code;
        s.selfId = id;
        let rOpen = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          s.init();
          resolve(s);
        };
        r.on('open', () => {
          rOpen = true;
          s.attach(hostId, r, 'r');
          if (u.open) finish();
          else setTimeout(() => { if (!u.open) s.unreliableOk = false; finish(); }, UNRELIABLE_WAIT_MS);
        });
        u.on('open', () => {
          s.attach(hostId, u, 'u');
          if (rOpen) finish();
        });
        r.on('error', () => fail('Could not connect'));
        r.on('close', () => fail('Could not connect'));
      });
    });
  }

  private init(): void {
    this.pingTimer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  // -------- connections

  private onIncoming(c: DataConnection): void {
    if (this.closed) { c.close(); return; }
    const kind: ChannelKind = c.label === 'u' ? 'u' : 'r';
    c.on('open', () => {
      const had = !!this.links.get(c.peer)?.r?.open;
      this.attach(c.peer, c, kind);
      if (kind === 'r' && !had) this.firePeers();
    });
  }

  private attach(peerId: string, c: DataConnection, kind: ChannelKind): void {
    let l = this.links.get(peerId);
    if (!l) { l = { r: null, u: null, lastSeen: now(), rtt: 0 }; this.links.set(peerId, l); }
    l[kind] = c;
    l.lastSeen = now();
    c.on('data', (d) => this.onData(peerId, d));
    c.on('close', () => {
      const cur = this.links.get(peerId);
      if (!cur || cur[kind] !== c) return;
      cur[kind] = null;
      if (kind === 'r') this.dropPeer(peerId);
    });
    c.on('error', () => { /* close handler / heartbeat deals with it */ });
  }

  private dropPeer(peerId: string): void {
    const l = this.links.get(peerId);
    if (!l) return;
    this.links.delete(peerId);
    try { l.r?.close(); } catch { /* ignore */ }
    try { l.u?.close(); } catch { /* ignore */ }
    if (!this.closed) this.firePeers();
  }

  private firePeers(): void {
    const p = this.peers;
    for (const h of this.peerHandlers.slice()) {
      try { h(p); } catch (e) { console.error('net peer handler error', e); }
    }
  }

  private onData(from: string, raw: unknown): void {
    if (this.closed || !raw || typeof raw !== 'object') return;
    const l = this.links.get(from);
    if (l) l.lastSeen = now();
    const m = raw as NetMessage | Ping;
    if (m.type === '__ping') { this.rawSend(from, { type: '__pong', t: m.t }, 'r'); return; }
    if (m.type === '__pong') { if (l) l.rtt = Math.max(0, now() - m.t); return; }
    const msg = unpackMessage(m as NetMessage);
    if (this.isHost) {
      const wire = packMessage(msg);
      for (const id of relayTargets(msg, from, this.peers)) this.rawSend(id, wire, 'u');
    }
    for (const h of this.handlers.slice()) {
      try { h(msg, from); } catch (e) { console.error('net handler error', e); }
    }
  }

  private rawSend(to: string, msg: NetMessage | Ping, want: ChannelKind): void {
    const l = this.links.get(to);
    if (!l) return;
    let c: DataConnection | null = want === 'u' && this.unreliableOk && l.u && l.u.open ? l.u : l.r;
    if (!c || !c.open) c = l.r && l.r.open ? l.r : null;
    if (!c) return;
    try { c.send(msg); } catch { /* connection closing */ }
  }

  private tick(): void {
    if (this.closed) return;
    const t = now();
    for (const [id, l] of [...this.links]) {
      if (t - l.lastSeen > TIMEOUT_MS) { this.dropPeer(id); continue; }
      this.rawSend(id, { type: '__ping', t }, 'r');
    }
  }

  // -------- public API

  send(msg: NetMessage, to?: string): void {
    if (this.closed) return;
    const wire = packMessage(msg);
    const ch = channelFor(msg.type);
    for (const id of sendTargets(this.isHost, this.peers, to)) this.rawSend(id, wire, ch);
  }

  on(handler: NetHandler): void { this.handlers.push(handler); }

  onPeerChange(handler: (peers: string[]) => void): void { this.peerHandlers.push(handler); }

  /** Round-trip time in ms to a peer (0 until the first pong). */
  rttMs(peerId: string): number { return this.links.get(peerId)?.rtt ?? 0; }

  close(): void {
    if (this.closed) return;
    for (const id of this.peers) this.rawSend(id, { type: 'leave' }, 'r');
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const peer = this.peer;
    this.links.clear();
    setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 100);
  }
}
