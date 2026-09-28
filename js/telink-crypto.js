// Telink BLE Mesh v1 — crypto & packet primitives.
//
// Ported line-for-line from the reverse-engineered, hardware-verified Python
// implementation in kernelorg/ha-telink-mesh (custom_components/telink_mesh/protocol.py),
// which itself is a literal port of python-dimond (Google, Apache-2.0) and cross-checked
// against telinkpp (Vincent Paeder). See PROTOCOL.md for full provenance and test vectors.
//
// Isomorphic module: uses the Web Crypto API (globalThis.crypto.subtle), available both
// in browsers (secure context, required by Web Bluetooth anyway) and in modern Node.js
// (>=19), so the exact same code can be unit-tested with `node test/verify.mjs`.

export const SERVICE_UUID = '00010203-0405-0607-0809-0a0b0c0d1910';
export const NOTIFY_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1911';
export const COMMAND_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1912';
export const OTA_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1913';
export const PAIR_CHAR_UUID = '00010203-0405-0607-0809-0a0b0c0d1914';

// 16-bit service UUID carried in the BLE advertisement (different from the 128-bit
// custom GATT service UUID above, by Telink SDK convention).
export const ADV_SERVICE_UUID = 0x1910;
export const VENDOR_ID = 0x0211;

export const ADDR_CONNECTED = 0x0000; // the node we are connected to
export const ADDR_ALL = 0xffff;

// Opcodes of the generic Telink mesh light SDK (python-dimond / python-tikteck /
// "Fulife" / "Mesh Lamp" / V-TAC style firmware). Verified on real hardware upstream.
export const OP_GENERIC_ON_OFF = 0xd0;
export const OP_GENERIC_BRIGHTNESS = 0xd2;
export const OP_GENERIC_COLOR = 0xe2;
export const OP_STATUS_QUERY = 0xda;
export const OP_STATUS_REPORT = 0xdb;
export const OP_ONLINE_STATUS = 0xdc;
export const OP_ADDRESS_REPORT = 0xe1;

// Opcodes of the Lidl Livarno LUX / Briloner style firmware (telinkpp).
export const OP_LIVARNO_ON_OFF = 0xf0;
export const OP_LIVARNO_ATTRIBUTES = 0xf1;

export const PAIR_RESPONSE_OK = 0x0d;
export const PAIR_RESPONSE_FAIL = 0x0e;

export class TelinkAuthError extends Error {}
export class TelinkProtocolError extends Error {}

// --- byte helpers -----------------------------------------------------------

function reversed(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

function xorBytes(a, b) {
  const out = new Uint8Array(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function pad16(text) {
  const raw = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  if (raw.length > 16) throw new Error('mesh name / password limited to 16 bytes');
  const out = new Uint8Array(16);
  out.set(raw, 0);
  return out;
}

export function meshKey(name, password) {
  return xorBytes(pad16(name), pad16(password));
}

// --- AES-128-ECB single block, via the WebCrypto AES-CBC(IV=0) trick --------
//
// SubtleCrypto exposes no raw ECB mode. But AES-CBC encryption of the first block
// XORs the plaintext with the IV before the block cipher; with IV = 16 zero bytes
// that XOR is a no-op, so the first 16 ciphertext bytes are exactly the AES-ECB
// encryption of that one block. PKCS7 padding appends a further block we ignore.
async function aesEcbBlock(key16, block16) {
  const cryptoKey = await crypto.subtle.importKey('raw', key16, { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const iv = new Uint8Array(16);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, block16);
  return new Uint8Array(ciphertext).slice(0, 16);
}

// Telink's AES quirk: byte-reverse the key AND the data before a standard AES-ECB
// encryption, then byte-reverse the output.
export async function telinkEncrypt(key16, data16) {
  const revKey = reversed(key16);
  const revData = reversed(data16);
  const out = await aesEcbBlock(revKey, revData);
  return reversed(out);
}

// --- MAC address ---------------------------------------------------------

export function macToLe(address) {
  const parts = address.replace(/-/g, ':').split(':');
  if (parts.length !== 6) throw new Error(`invalid MAC address ${address}`);
  const bytes = parts.map((p) => parseInt(p, 16));
  return new Uint8Array(bytes.reverse());
}

export function leToMac(raw) {
  if (raw.length !== 6) throw new Error('MAC must be 6 bytes');
  return Array.from(raw)
    .slice()
    .reverse()
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}

// --- pairing / login ------------------------------------------------------

export async function buildPairRequest(name, password, random8) {
  if (!random8) {
    random8 = crypto.getRandomValues(new Uint8Array(8));
  }
  if (random8.length !== 8) throw new Error('random8 must be 8 bytes');
  const key = concatBytes(random8, new Uint8Array(8));
  const encrypted = await telinkEncrypt(key, meshKey(name, password));
  const packet = concatBytes(new Uint8Array([0x0c]), random8, encrypted.slice(0, 8));
  return { packet, random8 };
}

export async function parsePairResponse(name, password, random8, response) {
  if (response.length < 9) {
    throw new TelinkProtocolError(`pairing response too short: ${toHex(response)}`);
  }
  if (response[0] === PAIR_RESPONSE_FAIL) {
    throw new TelinkAuthError('device rejected mesh name / password');
  }
  if (response[0] !== PAIR_RESPONSE_OK) {
    throw new TelinkProtocolError(`unexpected pairing response 0x${response[0].toString(16)}`);
  }
  return telinkEncrypt(meshKey(name, password), concatBytes(random8, response.slice(1, 9)));
}

// --- packet encrypt / decrypt ---------------------------------------------

export async function encryptPacket(sessionKey, macLe, packet20) {
  if (packet20.length !== 20) throw new Error('packet must be 20 bytes');
  const pkt = Uint8Array.from(packet20);
  const nonce = concatBytes(
    macLe.slice(0, 4),
    new Uint8Array([0x01]),
    pkt.slice(0, 3),
    new Uint8Array([0x0f]),
    new Uint8Array(7)
  );
  const auth = await telinkEncrypt(sessionKey, nonce);
  for (let i = 0; i < 15; i++) auth[i] ^= pkt[i + 5];
  const mac = await telinkEncrypt(sessionKey, auth);
  pkt[3] = mac[0];
  pkt[4] = mac[1];
  const iv = concatBytes(
    new Uint8Array([0x00]),
    macLe.slice(0, 4),
    new Uint8Array([0x01]),
    pkt.slice(0, 3),
    new Uint8Array(7)
  );
  const stream = await telinkEncrypt(sessionKey, iv);
  for (let i = 0; i < 15; i++) pkt[i + 5] ^= stream[i];
  return pkt;
}

export async function decryptPacket(sessionKey, macLe, packet) {
  if (packet.length < 8) throw new TelinkProtocolError(`notification too short: ${toHex(packet)}`);
  const pkt = Uint8Array.from(packet);
  const iv = concatBytes(macLe.slice(0, 3), pkt.slice(0, 5), new Uint8Array(7));
  const stream = await telinkEncrypt(sessionKey, iv);
  const n = Math.min(pkt.length - 7, 16);
  for (let i = 0; i < n; i++) pkt[i + 7] ^= stream[i];
  return pkt;
}

// --- sequence counter -------------------------------------------------------

export class SequenceCounter {
  constructor(start) {
    this._value = start ?? 1 + Math.floor(Math.random() * 0xfffe);
  }
  next() {
    const value = this._value;
    this._value = this._value < 0xffff ? this._value + 1 : 1;
    return value;
  }
}

// --- command packets --------------------------------------------------------

export async function buildCommand(
  sessionKey,
  macLe,
  sequence,
  target,
  opcode,
  params = new Uint8Array(0),
  vendor = VENDOR_ID
) {
  const p = params instanceof Uint8Array ? params : new Uint8Array(params);
  if (p.length > 10) throw new Error('at most 10 parameter bytes fit in a packet');
  const pkt = new Uint8Array(20);
  pkt[0] = sequence & 0xff;
  pkt[1] = (sequence >> 8) & 0xff;
  pkt[5] = target & 0xff;
  pkt[6] = (target >> 8) & 0xff;
  pkt[7] = opcode & 0xff;
  pkt[8] = vendor & 0xff;
  pkt[9] = (vendor >> 8) & 0xff;
  pkt.set(p, 10);
  return encryptPacket(sessionKey, macLe, pkt);
}

export async function parseNotification(sessionKey, macLe, data, vendor = VENDOR_ID) {
  if (data.length < 10) return null;
  const pkt = await decryptPacket(sessionKey, macLe, data);
  if (pkt[8] !== (vendor & 0xff) || pkt[9] !== ((vendor >> 8) & 0xff)) return null;
  return {
    opcode: pkt[7],
    source: pkt[3] | (pkt[4] << 8),
    target: pkt[5] | (pkt[6] << 8),
    params: pkt.slice(10),
    raw: pkt,
  };
}

export function parseOnlineStatus(params) {
  const entries = [];
  for (let offset = 0; offset + 4 <= params.length; offset += 4) {
    const meshId = params[offset];
    const sequence = params[offset + 1];
    const brightness = params[offset + 2];
    const reserved = params[offset + 3];
    if (meshId === 0x00 || meshId === 0xff) continue;
    entries.push({
      meshId,
      sequence,
      brightness,
      reserved,
      online: sequence !== 0 || brightness !== 0,
      isOn: reserved === 0x41 ? false : reserved === 0x40 ? true : brightness > 0,
    });
  }
  return entries;
}

export function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}
