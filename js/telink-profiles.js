// Command "profiles" — how (power / brightness / rgb / color_temp) map onto
// (opcode, params) for the two Telink firmware families seen on cheap E27 RGB+CCT
// bulbs. Ported from ha-telink-mesh's protocol.py CommandProfile subclasses.
import {
  OP_GENERIC_ON_OFF,
  OP_GENERIC_BRIGHTNESS,
  OP_GENERIC_COLOR,
  OP_LIVARNO_ON_OFF,
  OP_LIVARNO_ATTRIBUTES,
} from './telink-crypto.js';

function clampBrightness(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v))) & 0xff;
}

export const GenericProfile = {
  key: 'generic',
  label: 'Genérico (Fulife / Mesh Lamp / V-TAC)',
  trustStatusReport: false,
  minKelvin: 3000,
  maxKelvin: 6000,

  power(on) {
    return { opcode: OP_GENERIC_ON_OFF, params: new Uint8Array([on ? 1 : 0, 0, 0]) };
  },
  brightness(brightness) {
    return { opcode: OP_GENERIC_BRIGHTNESS, params: new Uint8Array([clampBrightness(brightness)]) };
  },
  rgb(r, g, b) {
    return { opcode: OP_GENERIC_COLOR, params: new Uint8Array([0x04, clampByte(r), clampByte(g), clampByte(b)]) };
  },
  colorTemp(kelvin, { minKelvin = this.minKelvin, maxKelvin = this.maxKelvin } = {}) {
    const lo = minKelvin;
    const hi = Math.max(lo + 1, maxKelvin);
    const k = Math.max(lo, Math.min(hi, kelvin));
    // Inverted: 0 = coldest (max K), 100 = warmest (min K).
    const percent = Math.round(((hi - k) * 100) / (hi - lo));
    return { opcode: OP_GENERIC_COLOR, params: new Uint8Array([0x05, percent]) };
  },
};

export const LivarnoProfile = {
  key: 'livarno',
  label: 'Livarno / Briloner (Lidl)',
  trustStatusReport: true,
  minKelvin: 2700,
  maxKelvin: 6500,

  power(on) {
    return { opcode: OP_LIVARNO_ON_OFF, params: new Uint8Array([on ? 1 : 0, 0, 0]) };
  },
  brightness(brightness) {
    return {
      opcode: OP_LIVARNO_ATTRIBUTES,
      params: new Uint8Array([clampBrightness(brightness), 0, 0, 0, 0, 0, 0, 1]),
    };
  },
  rgb(r, g, b, brightness = 100) {
    const bright = Math.max(1, clampBrightness(brightness));
    return {
      opcode: OP_LIVARNO_ATTRIBUTES,
      params: new Uint8Array([bright, clampByte(r), clampByte(g), clampByte(b), 0, 0, 0, 0]),
    };
  },
  colorTemp(kelvin, { minKelvin = this.minKelvin, maxKelvin = this.maxKelvin, brightness = 100 } = {}) {
    const bright = Math.max(1, clampBrightness(brightness));
    const lo = minKelvin;
    const hi = Math.max(lo + 1, maxKelvin);
    const k = Math.max(lo, Math.min(hi, kelvin));
    const [y, w] = kelvinToYW(k, lo, hi);
    return { opcode: OP_LIVARNO_ATTRIBUTES, params: new Uint8Array([bright, 0, 0, 0, y, w, 0, 0]) };
  },
};

function kelvinToYW(kelvin, lo = 2700, hi = 6500) {
  const mid = 4600; // fixed inflection point used by telinkpp regardless of override range
  if (kelvin > mid) {
    return [Math.round(((hi - kelvin) * 255) / (hi - mid)), 255];
  }
  return [255, Math.round(((kelvin - lo) * 255) / (mid - lo))];
}

export const PROFILES = { generic: GenericProfile, livarno: LivarnoProfile };

export function getProfile(key) {
  return PROFILES[key] || GenericProfile;
}

// Known credential presets, from the ha-telink-mesh config flow. The factory-default
// SDK credentials (telink_mesh1/123) are tried first since the user reset the lamp.
export const CREDENTIAL_PRESETS = [
  { id: 'sdk_default', label: 'SDK Telink por defecto', name: 'telink_mesh1', password: '123', profile: 'generic' },
  { id: 'sdk_default0', label: 'SDK Telink (variante 0)', name: 'telink_mesh0', password: '123', profile: 'generic' },
  { id: 'fulife', label: 'Fulife / Mesh Lamp / V-TAC', name: 'Fulife', password: '2846', profile: 'generic' },
];
