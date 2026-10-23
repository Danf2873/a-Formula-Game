// Lobby and in-race glue between NetSession and World.
import type { Entry, NetMessage, SessionConfig } from '../types';
import { NetSession } from '../net/net';
import { DRIVERS, driverById } from '../data/grid';
import type { World, WorldNet } from './world';

export interface LobbyPlayer { peerId: string; name: string; driverId: string; ready: boolean }

export interface LobbyView {
  update(state: { code: string; isHost: boolean; players: LobbyPlayer[]; config: SessionConfig }): void;
  error(msg: string): void;
  /** Called on every peer with the final entry list when the host starts the race. */
  start(config: SessionConfig, entries: Entry[], seed: number, selfEntryId: string): void;
  closed(): void;
}

export class Multiplayer {
  readonly net: NetSession;
  players: LobbyPlayer[] = [];
  config: SessionConfig;
  world: World | null = null;
  private view: LobbyView;

  private constructor(net: NetSession, name: string, driverId: string, config: SessionConfig, view: LobbyView) {
    this.net = net;
    this.config = config;
    this.view = view;
    if (net.isHost) this.players = [{ peerId: net.selfId, name, driverId, ready: true }];
    net.on((m, from) => this.onMessage(m, from));
    net.onPeerChange((peers) => {
      if (net.isHost) {
        this.players = this.players.filter((p) => p.peerId === net.selfId || peers.includes(p.peerId));
        this.broadcastLobby();
      } else if (peers.length === 0) {
        view.error('Lost connection to the host');
        view.closed();
      }
    });
    if (!net.isHost) net.send({ type: 'hello', name, driverId, version: '1' });
    this.pushView();
  }

  static async host(name: string, driverId: string, config: SessionConfig, view: LobbyView): Promise<Multiplayer> {
    const net = await NetSession.host(name);
    return new Multiplayer(net, name, driverId, config, view);
  }

  static async join(code: string, name: string, driverId: string, config: SessionConfig, view: LobbyView): Promise<Multiplayer> {
    const net = await NetSession.join(code, name);
    return new Multiplayer(net, name, driverId, config, view);
  }

  get selfEntryId(): string { return 'p:' + this.net.selfId; }

  setReady(ready: boolean): void {
    const me = this.players.find((p) => p.peerId === this.net.selfId);
    if (me) me.ready = ready;
    if (this.net.isHost) this.broadcastLobby();
    else this.net.send({ type: 'ready', ready, driverId: me?.driverId ?? '' });
  }

  setConfig(c: SessionConfig): void {
    if (!this.net.isHost) return;
    this.config = c;
    this.broadcastLobby();
  }

  /** Host: build the entry list (humans + AI fill) and start everyone. */
  start(): void {
    if (!this.net.isHost) return;
    const entries: Entry[] = this.players.map((p) => {
      const d = driverById(p.driverId);
      return { id: 'p:' + p.peerId, driverId: d.id, displayName: p.name || d.lastName, teamId: d.teamId, kind: 'remote' };
    });
    const taken = new Set(entries.map((e) => e.driverId));
    const ai = DRIVERS.filter((d) => !taken.has(d.id)).slice(0, Math.max(0, Math.min(this.config.aiCount, 22 - entries.length)));
    for (const d of ai) entries.push({ id: d.id, driverId: d.id, displayName: `${d.firstName} ${d.lastName}`, teamId: d.teamId, kind: 'ai' });
    const seed = (Math.random() * 2 ** 31) | 0;
    this.net.send({ type: 'start', config: this.config, entries, seed });
    this.view.start(this.config, localise(entries, this.selfEntryId), seed, this.selfEntryId);
  }

  /** Hooks for World. */
  worldNet(): WorldNet {
    const net = this.net;
    return {
      isHost: net.isHost,
      selfEntryId: this.selfEntryId,
      sendCar: (state) => net.send({ type: 'car', state }),
      sendCars: (states) => net.send({ type: 'cars', states }),
      sendSession: (snapshot, weather) => net.send({ type: 'session', snapshot, weather }),
    };
  }

  leave(): void {
    this.net.close();
    this.view.closed();
  }

  private onMessage(m: NetMessage, from: string): void {
    const now = performance.now();
    switch (m.type) {
      case 'hello':
        if (!this.net.isHost) return;
        if (!this.players.some((p) => p.peerId === from)) {
          this.players.push({ peerId: from, name: m.name.slice(0, 20), driverId: safeDriver(m.driverId), ready: false });
        }
        this.broadcastLobby();
        return;
      case 'ready': {
        if (!this.net.isHost) return;
        const p = this.players.find((x) => x.peerId === from);
        if (p) { p.ready = m.ready; if (m.driverId) p.driverId = safeDriver(m.driverId); }
        this.broadcastLobby();
        return;
      }
      case 'lobby':
        this.players = m.players;
        this.config = m.config;
        this.pushView();
        return;
      case 'start':
        this.config = m.config;
        this.view.start(m.config, localise(m.entries, this.selfEntryId), m.seed, this.selfEntryId);
        return;
      case 'car':
        this.world?.onNetCar(m.state, now);
        return;
      case 'cars':
        for (const s of m.states) this.world?.onNetCar(s, now);
        return;
      case 'session':
        if (!this.net.isHost) this.world?.onNetSession(m.snapshot, m.weather);
        return;
      default:
        return;
    }
  }

  private broadcastLobby(): void {
    this.net.send({ type: 'lobby', players: this.players, config: this.config, hostId: this.net.selfId });
    this.pushView();
  }

  private pushView(): void {
    this.view.update({ code: this.net.code, isHost: this.net.isHost, players: this.players, config: this.config });
  }
}

/** Each peer sees itself as the 'player' and other humans as 'remote'. */
function localise(entries: Entry[], selfId: string): Entry[] {
  return entries.map((e) => (e.kind === 'ai' ? e : { ...e, kind: e.id === selfId ? 'player' : 'remote' }));
}

function safeDriver(id: string): string {
  return DRIVERS.some((d) => d.id === id) ? id : DRIVERS[0].id;
}
