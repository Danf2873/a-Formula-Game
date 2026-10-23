// Room codes: 6 chars from an unambiguous alphabet, mapped to PeerJS id 'afg-<CODE>'.

export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export const ROOM_CODE_LENGTH = 6;
export const PEER_PREFIX = 'afg-';

export function generateRoomCode(rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.min(ROOM_ALPHABET.length - 1, Math.floor(rng() * ROOM_ALPHABET.length));
    s += ROOM_ALPHABET[idx];
  }
  return s;
}

/** Uppercase and strip spaces, dashes and any other non-alphanumerics. Does not remap characters. */
export function normaliseRoomCode(input: string): string {
  return (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return false;
  return true;
}

export function peerIdForCode(code: string): string {
  return PEER_PREFIX + normaliseRoomCode(code);
}
