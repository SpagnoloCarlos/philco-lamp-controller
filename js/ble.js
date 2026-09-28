// Web Bluetooth transport for a single Telink mesh node.
//
// IMPORTANT platform limitation: the Telink command/notification crypto mixes the
// device's real BLE MAC address into the CBC-MAC nonce / CTR IV (see PROTOCOL.md).
// Chrome's Web Bluetooth API deliberately never exposes the real MAC to a web page
// (BluetoothDevice.id is an opaque, origin-scoped token — not the MAC — and
// watchAdvertisements()/manufacturer data is unavailable on Android Chrome). So this
// app cannot learn the MAC on its own; the user enters it once (e.g. read it with a
// generic BLE scanner app like "nRF Connect") and we verify it with a real command.
import * as T from './telink-crypto.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelinkAuthError extends T.TelinkAuthError {}

export class TelinkSession extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.chPair = null;
    this.chCmd = null;
    this.chNotify = null;
    this.sessionKey = null;
    this.macLe = null;
    this.meshName = null;
    this.meshPassword = null;
    this.sequence = new T.SequenceCounter();
    this.notificationsEnabled = false;
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  /** Opens the browser's "choose a Bluetooth device" picker, filtered to Telink devices. */
  async requestDevice() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [T.ADV_SERVICE_UUID] }],
      optionalServices: [T.SERVICE_UUID],
    });
    return this.device;
  }

  /** Unfiltered picker — diagnostics fallback when the lamp doesn't match the Telink filter. */
  async requestDeviceAny() {
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [T.SERVICE_UUID],
    });
    return this.device;
  }

  /** Reuses a device object obtained earlier in this page session (no picker shown). */
  useDevice(device) {
    this.device = device;
  }

  async connectGatt() {
    if (!this.device) throw new Error('No hay dispositivo seleccionado');
    this.device.removeEventListener?.('gattserverdisconnected', this._onGattDisconnect);
    this._onGattDisconnect = () => this.dispatchEvent(new Event('disconnected'));
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(T.SERVICE_UUID);
    this.chPair = await service.getCharacteristic(T.PAIR_CHAR_UUID);
    this.chCmd = await service.getCharacteristic(T.COMMAND_CHAR_UUID);
    this.chNotify = await service.getCharacteristic(T.NOTIFY_CHAR_UUID);
    return service;
  }

  /** Lists every service/characteristic the device exposes (diagnostics screen). */
  async exploreGatt() {
    const services = await this.server.getPrimaryServices();
    const out = [];
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      out.push({
        uuid: svc.uuid,
        characteristics: chars.map((c) => ({
          uuid: c.uuid,
          properties: Object.entries(c.properties)
            .filter(([, v]) => v)
            .map(([k]) => k),
        })),
      });
    }
    return out;
  }

  async login(name, password) {
    const { packet, random8 } = await T.buildPairRequest(name, password);
    await this.chPair.writeValueWithResponse(packet);
    await sleep(300);
    const view = await this.chPair.readValue();
    const resp = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.sessionKey = await T.parsePairResponse(name, password, random8, resp);
    this.meshName = name;
    this.meshPassword = password;
    return true;
  }

  /**
   * Tries a list of {name, password, profile, label} presets in order; returns the
   * one that logged in. `onResult(preset, ok, error)` fires after each attempt (error
   * is null on success) so the caller can show the real failure reason, not just "failed".
   */
  async loginWithPresets(presets, onResult) {
    let lastErr = new Error('sin credenciales para probar');
    for (const preset of presets) {
      try {
        await this.login(preset.name, preset.password);
        onResult?.(preset, true, null);
        return preset;
      } catch (err) {
        lastErr = err;
        onResult?.(preset, false, err);
      }
    }
    throw lastErr;
  }

  async enableNotifications() {
    this._rawListener = (ev) => this._onNotify(ev);
    try {
      await this.chNotify.startNotifications();
      this.chNotify.addEventListener('characteristicvaluechanged', this._rawListener);
      this.notificationsEnabled = true;
    } catch (err) {
      this.notificationsEnabled = false;
    }
    // Telink firmwares also expect a plain value write to ask the node to start
    // reporting; harmless if unsupported.
    try {
      await this.chNotify.writeValueWithResponse(new Uint8Array([0x01]));
    } catch (err) {
      /* ignore */
    }
  }

  _onNotify(ev) {
    const view = ev.target.value;
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.dispatchEvent(new CustomEvent('raw-notify', { detail: data }));

    // Opportunistic MAC auto-discovery: right after a factory reset some Telink
    // firmwares emit ONE unencrypted address-report (opcode 0xE1) so a fresh
    // controller can learn the node's MAC before any session key exists.
    if (!this.macLe && data.length >= 16 && data[7] === T.OP_ADDRESS_REPORT) {
      const mac = data.slice(10, 16);
      this.dispatchEvent(new CustomEvent('mac-detected', { detail: mac }));
    }

    if (!this.sessionKey || !this.macLe) return;
    T.parseNotification(this.sessionKey, this.macLe, data)
      .then((note) => {
        if (note) this.dispatchEvent(new CustomEvent('notify', { detail: note }));
      })
      .catch(() => {});
  }

  /** @param {string|Uint8Array} mac "AA:BB:CC:DD:EE:FF" or already-little-endian bytes */
  setMac(mac) {
    this.macLe = typeof mac === 'string' ? T.macToLe(mac) : mac;
  }

  get macString() {
    return this.macLe ? T.leToMac(this.macLe) : null;
  }

  async send(opcode, params, target = T.ADDR_CONNECTED) {
    if (!this.sessionKey) throw new Error('No hay sesión iniciada (falta login)');
    if (!this.macLe) throw new Error('Falta la dirección MAC de la lámpara');
    const packet = await T.buildCommand(
      this.sessionKey,
      this.macLe,
      this.sequence.next(),
      target,
      opcode,
      params
    );
    await this.chCmd.writeValueWithoutResponse(packet);
  }

  async disconnect() {
    try {
      this.device?.gatt?.disconnect();
    } catch (err) {
      /* ignore */
    }
    this.sessionKey = null;
  }
}

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}
