// Command "profiles" — how (power / brightness / rgb / color_temp / music) map onto
// (opcode, params) for the lamp.
//
// The "generic" profile below is no longer a guess: every opcode and subcommand value
// was extracted directly from the decompiled official Philco Smart Color app
// (Jingxun's React Native bundle, `index.android.bundle`), which itself is a thin
// wrapper around the real Telink Android SDK (com.telink.bluetooth.*). See
// PROTOCOL.md "Opcodes verificados desde la app original" for the full trace.
import {
  OP_GENERIC_ON_OFF,
  OP_LIGHT_ADJUST,
  OP_LIGHT_ADJUST_LUM,
  OP_RESET_DEVICE,
  LIGHT_ADJUST,
  OP_LIVARNO_ON_OFF,
  OP_LIVARNO_ATTRIBUTES,
} from './telink-crypto.js';

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v))) & 0xff;
}

export const GenericProfile = {
  key: 'generic',
  label: 'Philco Smart Color (verificado desde la app original)',
  trustStatusReport: false,
  minKelvin: 2700,
  maxKelvin: 6500,

  power(on) {
    return { opcode: OP_GENERIC_ON_OFF, params: new Uint8Array([on ? 1 : 0, 0, 0]) };
  },
  brightness(pct) {
    return { opcode: OP_LIGHT_ADJUST, params: new Uint8Array([LIGHT_ADJUST.BRIGHTNESS, clampPct(pct)]) };
  },
  rgb(r, g, b) {
    return { opcode: OP_LIGHT_ADJUST, params: new Uint8Array([LIGHT_ADJUST.COLOR_RGB, clampByte(r), clampByte(g), clampByte(b)]) };
  },
  rgbAndBrightness(r, g, b, pct) {
    return {
      opcode: OP_LIGHT_ADJUST,
      params: new Uint8Array([LIGHT_ADJUST.COLOR_RGB_AND_BRIGHTNESS, clampByte(r), clampByte(g), clampByte(b), clampPct(pct)]),
    };
  },
  /** cold/warm are raw 0-255 channel levels, exactly like the official app sends. */
  colorTempDivided(cold, warm) {
    return { opcode: OP_LIGHT_ADJUST, params: new Uint8Array([LIGHT_ADJUST.COLOR_TEMP, clampByte(cold), clampByte(warm)]) };
  },
  /** percent: 0 = warmest, 100 = coldest (matches the manual's Cálido↔Frío slider). */
  colorTemp(percent) {
    const cold = Math.round((clampPct(percent) / 100) * 255);
    const warm = 255 - cold;
    return this.colorTempDivided(cold, warm);
  },
  rgbcw(r, g, b, cold, warm) {
    return {
      opcode: OP_LIGHT_ADJUST,
      params: new Uint8Array([LIGHT_ADJUST.COLOR_RGBCW, clampByte(r), clampByte(g), clampByte(b), clampByte(cold), clampByte(warm)]),
    };
  },
  all(r, g, b, cold, warm, pct) {
    return {
      opcode: OP_LIGHT_ADJUST,
      params: new Uint8Array([LIGHT_ADJUST.ALL, clampByte(r), clampByte(g), clampByte(b), clampByte(cold), clampByte(warm), clampPct(pct)]),
    };
  },
  // --- "luces rítmicas" (music mode) — opcode 0xD2, completely separate from
  // LIGHT_ADJUST (0xE2) above despite the similar name in the SDK.
  musicEnter() {
    return { opcode: OP_LIGHT_ADJUST_LUM, params: new Uint8Array([254]) };
  },
  musicExit() {
    return { opcode: OP_LIGHT_ADJUST_LUM, params: new Uint8Array([255]) };
  },
  /** level: 16-100 (loudness-derived); r/g/b: the currently selected base colour. */
  musicFrame(level, r, g, b) {
    const lvl = Math.max(16, Math.min(100, Math.round(level)));
    return { opcode: OP_LIGHT_ADJUST_LUM, params: new Uint8Array([lvl, clampByte(r), clampByte(g), clampByte(b), 0]) };
  },
  // Requires an authenticated session; see PROTOCOL.md for why this alone may not be
  // enough to "un-claim" a lamp that already rejects the factory mesh credentials.
  resetDevice() {
    return { opcode: OP_RESET_DEVICE, params: new Uint8Array([1]) };
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
      params: new Uint8Array([clampPct(brightness), 0, 0, 0, 0, 0, 0, 1]),
    };
  },
  rgb(r, g, b, brightness = 100) {
    const bright = Math.max(1, clampPct(brightness));
    return {
      opcode: OP_LIVARNO_ATTRIBUTES,
      params: new Uint8Array([bright, clampByte(r), clampByte(g), clampByte(b), 0, 0, 0, 0]),
    };
  },
  colorTempKelvin(kelvin, { minKelvin = this.minKelvin, maxKelvin = this.maxKelvin, brightness = 100 } = {}) {
    const bright = Math.max(1, clampPct(brightness));
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

// Known credential presets, tried in order on connect. FACTORY_NAME/FACTORY_PASSWORD
// in the decompiled app are literally "telink_mesh1"/"123" (confirmed: no Philco-
// specific override exists), so that's tried first since a reset lamp should accept it.
export const CREDENTIAL_PRESETS = [
  { id: 'sdk_default', label: 'SDK Telink por defecto', name: 'telink_mesh1', password: '123', profile: 'generic' },
  { id: 'sdk_default0', label: 'SDK Telink (variante 0)', name: 'telink_mesh0', password: '123', profile: 'generic' },
  { id: 'fulife', label: 'Fulife / Mesh Lamp / V-TAC', name: 'Fulife', password: '2846', profile: 'generic' },
];
