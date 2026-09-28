// Validates js/telink-crypto.js against the exact test vectors from
// kernelorg/ha-telink-mesh's tests/test_protocol.py (a literal port of python-dimond),
// plus a from-scratch reimplementation of the dimond reference algorithm using Node's
// native AES-128-ECB, so two independent code paths must agree.
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import * as T from '../js/telink-crypto.js';
import { getProfile } from '../js/telink-profiles.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

let failures = 0;
function test(name, fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Promise) throw e; // shouldn't happen, guard against misuse
    console.error(`FAIL  ${name}\n      ${e.message}`);
    failures++;
    return;
  }
  console.log(`ok    ${name}`);
}
async function atest(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack}`);
    failures++;
  }
}

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function bytesEq(a, b, msg) {
  assert.equal(hex(a), hex(b), msg);
}

// --- independent reference implementation (Node's built-in AES-ECB) --------
import { createCipheriv } from 'node:crypto';
function nodeAesEcb(key, data) {
  const c = createCipheriv('aes-128-ecb', Buffer.from(key), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.from(data)), c.final()]);
}
function rev(b) {
  return Uint8Array.from(b).reverse();
}
function refTelinkEncrypt(key, data) {
  return rev(nodeAesEcb(rev(key), rev(data)));
}
function refPad16(s) {
  const raw = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(16);
  raw.copy(out);
  return out;
}
function refMeshKey(name, password) {
  const n = refPad16(name),
    p = refPad16(password);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = n[i] ^ p[i];
  return out;
}
function refDimondSendPacket(sk, macdata, count, vendor, target, command, data) {
  const packet = new Uint8Array(20);
  packet[0] = count & 0xff;
  packet[1] = (count >> 8) & 0xff;
  packet[5] = target & 0xff;
  packet[6] = (target >> 8) & 0xff;
  packet[7] = command;
  packet[8] = vendor & 0xff;
  packet[9] = (vendor >> 8) & 0xff;
  packet.set(data, 10);
  return refDimondEncryptPacket(sk, macdata, packet);
}
function refDimondEncryptPacket(sk, address, packet) {
  packet = Uint8Array.from(packet);
  const authNonce = new Uint8Array([
    address[0], address[1], address[2], address[3], 0x01,
    packet[0], packet[1], packet[2], 15, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const authenticator = refTelinkEncrypt(sk, authNonce);
  for (let i = 0; i < 15; i++) authenticator[i] ^= packet[i + 5];
  const mac = refTelinkEncrypt(sk, authenticator);
  packet[3] = mac[0];
  packet[4] = mac[1];
  const iv = new Uint8Array([
    0, address[0], address[1], address[2], address[3], 0x01, packet[0], packet[1], packet[2],
    0, 0, 0, 0, 0, 0, 0,
  ]);
  const tempBuffer = refTelinkEncrypt(sk, iv);
  for (let i = 0; i < 15; i++) packet[i + 5] ^= tempBuffer[i];
  return packet;
}

const MAC = 'A4:C1:38:12:34:56';
const MACDATA = new Uint8Array([0x56, 0x34, 0x12, 0x38, 0xc1, 0xa4]);
const NAME = 'telink_mesh1';
const PASSWORD = '123';

test('mac_to_le / le_to_mac roundtrip', () => {
  bytesEq(T.macToLe(MAC), MACDATA, 'macToLe');
  assert.equal(T.leToMac(T.macToLe(MAC)), MAC);
});

await atest('build_pair_request matches dimond reference', async () => {
  const random8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const { packet } = await T.buildPairRequest(NAME, PASSWORD, random8);
  const data = new Uint8Array(16);
  data.set(random8);
  const keyEnc = refTelinkEncrypt(data, refMeshKey(NAME, PASSWORD));
  const expected = new Uint8Array(17);
  expected[0] = 0x0c;
  expected.set(random8, 1);
  expected.set(keyEnc.slice(0, 8), 9);
  bytesEq(packet, expected, 'pair request packet');
});

await atest('parse_pair_response matches dimond reference (session key)', async () => {
  const random8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const response = new Uint8Array(17);
  response[0] = 0x0d;
  for (let i = 0; i < 16; i++) response[1 + i] = 0x10 + i;
  const sk = await T.parsePairResponse(NAME, PASSWORD, random8, response);
  const data = new Uint8Array(16);
  data.set(random8, 0);
  data.set(response.slice(1, 9), 8);
  const expected = refTelinkEncrypt(refMeshKey(NAME, PASSWORD), data);
  bytesEq(sk, expected, 'session key');
});

await atest('parse_pair_response rejects PAIR_RESPONSE_FAIL', async () => {
  let threw = false;
  try {
    await T.parsePairResponse(NAME, PASSWORD, new Uint8Array(8), new Uint8Array(17).fill(0, 0, 1).map((_, i) => (i === 0 ? 0x0e : 0)));
  } catch (e) {
    threw = e instanceof T.TelinkAuthError;
  }
  assert.ok(threw, 'expected TelinkAuthError');
});

await atest('build_command matches dimond reference', async () => {
  const sk = Uint8Array.from({ length: 16 }, (_, i) => i);
  const params = new Uint8Array([0x64, 0xff, 0x00, 0x80, 0, 0, 0, 0]);
  const ours = await T.buildCommand(sk, T.macToLe(MAC), 0x1234, 0x0005, 0xf1, params);
  const ref = refDimondSendPacket(sk, MACDATA, 0x1234, 0x0211, 0x0005, 0xf1, params);
  bytesEq(ours, ref, 'command packet');
});

await atest('encrypt/decrypt are mutually consistent (stream cipher symmetry)', async () => {
  const sk = Uint8Array.from({ length: 16 }, (_, i) => i + 16);
  const macLe = T.macToLe(MAC);
  const plain = new Uint8Array(20);
  plain.set([0x01, 0x02, 0x03], 0);
  plain[3] = 0x07;
  plain[7] = T.OP_ONLINE_STATUS;
  plain[8] = 0x11;
  plain[9] = 0x02;
  plain.set([0x07, 0x05, 0x64, 0x40], 10);
  plain.set([0x08, 0x00, 0x00, 0x00], 14);
  // decrypting plaintext == encrypting it (XOR stream cipher is symmetric); this mirrors
  // the Python test's trick to synthesize a valid "wire" notification without a real device.
  const wire = await T.decryptPacket(sk, macLe, plain);
  const note = await T.parseNotification(sk, macLe, wire);
  assert.ok(note, 'notification should parse');
  assert.equal(note.opcode, T.OP_ONLINE_STATUS);
  assert.equal(note.source, 0x07);
  const entries = T.parseOnlineStatus(note.params);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].isOn, true);
  assert.equal(entries[0].brightness, 100);
  assert.equal(entries[1].isOn, false);
});

test('parseOnlineStatus: off entry (Fulife capture)', () => {
  const params = Uint8Array.from('51,49,00,FF,00,00,00,00,00,00'.split(',').map((x) => parseInt(x, 16)));
  const entries = T.parseOnlineStatus(params);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meshId, 0x51);
  assert.equal(entries[0].online, true);
  assert.equal(entries[0].isOn, false);
});

test('parseOnlineStatus: on + dimmed entries (Fulife capture)', () => {
  let e = T.parseOnlineStatus(Uint8Array.from('51,64,64,FF,00,00,00,00,00,00'.split(',').map((x) => parseInt(x, 16))))[0];
  assert.equal(e.isOn, true);
  assert.equal(e.brightness, 100);
  e = T.parseOnlineStatus(Uint8Array.from('51,76,37,FF,00,00,00,00,00,00'.split(',').map((x) => parseInt(x, 16))))[0];
  assert.equal(e.isOn, true);
  assert.equal(e.brightness, 0x37);
});

// --- profile byte-output tests, matching test_protocol.py::ProfileTests -----

test('GenericProfile matches Python ProfileTests.test_generic', () => {
  const prof = getProfile('generic');
  let r = prof.power(false);
  assert.equal(r.opcode, 0xd0);
  bytesEq(r.params, [0, 0, 0]);
  r = prof.brightness(42);
  assert.equal(r.opcode, 0xd2);
  bytesEq(r.params, [0x2a]);
  r = prof.rgb(1, 2, 3);
  assert.equal(r.opcode, 0xe2);
  bytesEq(r.params, [4, 1, 2, 3]);
});

test('GenericProfile color_temp matches Python test_generic_color_temp_inverted_3000_6000', () => {
  const prof = getProfile('generic');
  assert.equal(prof.minKelvin, 3000);
  assert.equal(prof.maxKelvin, 6000);
  bytesEq(prof.colorTemp(6000).params, [5, 0]);
  bytesEq(prof.colorTemp(3000).params, [5, 100]);
  bytesEq(prof.colorTemp(4500).params, [5, 50]);
  bytesEq(prof.colorTemp(6500).params, [5, 0]); // clamps
  bytesEq(prof.colorTemp(2700).params, [5, 100]); // clamps
});

test('GenericProfile color_temp override range matches Python test', () => {
  const prof = getProfile('generic');
  bytesEq(prof.colorTemp(7000, { minKelvin: 2000, maxKelvin: 7000 }).params, [5, 0]);
  bytesEq(prof.colorTemp(2000, { minKelvin: 2000, maxKelvin: 7000 }).params, [5, 100]);
  bytesEq(prof.colorTemp(4500, { minKelvin: 2000, maxKelvin: 7000 }).params, [5, 50]);
});

test('GenericProfile.whiteLevel sends opcode 0xE2/0x05 as a plain 0-100 level', () => {
  const prof = getProfile('generic');
  bytesEq(prof.whiteLevel(0).params, [5, 0]);
  bytesEq(prof.whiteLevel(100).params, [5, 100]);
  bytesEq(prof.whiteLevel(37).params, [5, 37]);
  bytesEq(prof.whiteLevel(150).params, [5, 100]); // clamps
});

test('LivarnoProfile matches Python ProfileTests.test_livarno', () => {
  const prof = getProfile('livarno');
  let r = prof.power(true);
  assert.equal(r.opcode, 0xf0);
  bytesEq(r.params, [1, 0, 0]);
  r = prof.brightness(150); // clamps to 100
  assert.equal(r.opcode, 0xf1);
  bytesEq(r.params, [100, 0, 0, 0, 0, 0, 0, 1]);
  r = prof.rgb(1, 2, 3, 0);
  bytesEq(r.params, [1, 1, 2, 3, 0, 0, 0, 0]);
  r = prof.colorTemp(2700, { brightness: 50 });
  bytesEq(r.params, [50, 0, 0, 0, 255, 0, 0, 0]);
});

test('kelvin_to_yw matches telinkpp test vectors (via LivarnoProfile.colorTemp)', () => {
  const prof = getProfile('livarno');
  const yw = (k) => Array.from(prof.colorTemp(k, { brightness: 1 }).params.slice(4, 6));
  assert.deepEqual(yw(2700), [255, 0]);
  assert.deepEqual(yw(4600), [255, 255]);
  assert.deepEqual(yw(6500), [0, 255]);
  assert.deepEqual(yw(1000), [255, 0]); // clamps to 2700
  assert.deepEqual(yw(9000), [0, 255]); // clamps to 6500
});

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed.');
process.exit(failures ? 1 : 0);
