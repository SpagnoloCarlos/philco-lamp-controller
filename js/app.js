import * as T from './telink-crypto.js';
import { getProfile, CREDENTIAL_PRESETS } from './telink-profiles.js';
import { TelinkSession, bluetoothAvailable } from './ble.js';

// --- persistence ------------------------------------------------------------

const KEY = 'philco.';
const Store = {
  get(name, fallback) {
    const v = localStorage.getItem(KEY + name);
    if (v === null) return fallback;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  },
  set(name, value) {
    localStorage.setItem(KEY + name, typeof value === 'string' ? value : JSON.stringify(value));
  },
  remove(name) {
    localStorage.removeItem(KEY + name);
  },
};

const defaults = {
  meshName: 'telink_mesh1',
  meshPassword: '123',
  profile: 'generic',
  minKelvin: 3000,
  maxKelvin: 6000,
  mac: null,
  deviceId: null,
  favorites: [],
  lastColor: '#ff9d3c',
  lastBrightness: 100,
  lastMode: 'color', // 'color' | 'white'
  lastWhite: 50,
};

function loadSettings() {
  const s = {};
  for (const k of Object.keys(defaults)) s[k] = Store.get(k, defaults[k]);
  return s;
}
let settings = loadSettings();

function currentProfile() {
  const p = getProfile(settings.profile);
  return {
    ...p,
    minKelvin: Number(settings.minKelvin) || p.minKelvin,
    maxKelvin: Number(settings.maxKelvin) || p.maxKelvin,
  };
}

// --- session ------------------------------------------------------------

const session = new TelinkSession();

// --- DOM helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  brandDot: $('brandDot'),
  btnConnect: $('btnConnect'),
  statusLine: $('statusLine'),
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.panel'),

  btnPower: $('btnPower'),
  powerHint: $('powerHint'),
  sliderBrightness: $('sliderBrightness'),
  brightnessValue: $('brightnessValue'),
  colorPicker: $('colorPicker'),
  swatchesColor: $('swatchesColor'),
  sliderWhite: $('sliderWhite'),
  whiteTempRow: $('whiteTempRow'),
  whiteHint: $('whiteHint'),
  btnUseWhite: $('btnUseWhite'),
  btnSaveFavorite: $('btnSaveFavorite'),
  swatchesFavorites: $('swatchesFavorites'),
  favoritesHint: $('favoritesHint'),

  btnScanFiltered: $('btnScanFiltered'),
  btnScanAny: $('btnScanAny'),
  btnTryLogin: $('btnTryLogin'),
  loginPresetsLog: $('loginPresetsLog'),
  macInput: $('macInput'),
  btnTestMac: $('btnTestMac'),
  macDetectedHint: $('macDetectedHint'),
  btnExploreGatt: $('btnExploreGatt'),
  gattDump: $('gattDump'),
  diagLog: $('diagLog'),

  setMeshName: $('setMeshName'),
  setMeshPassword: $('setMeshPassword'),
  setProfile: $('setProfile'),
  setMinKelvin: $('setMinKelvin'),
  setMaxKelvin: $('setMaxKelvin'),
  setMac: $('setMac'),
  btnSaveSettings: $('btnSaveSettings'),
  btnForget: $('btnForget'),
};

function logDiag(msg) {
  const t = new Date().toLocaleTimeString('es-AR', { hour12: false });
  els.diagLog.textContent = `[${t}] ${msg}\n` + els.diagLog.textContent;
}

const PRESET_COLORS = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
  '#007aff', '#5856d6', '#af52de', '#ff2d92', '#ffffff', '#ff9d3c',
];

// --- tabs ------------------------------------------------------------

for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    for (const t of els.tabs) {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
    const name = tab.dataset.tab;
    for (const p of els.panels) p.classList.toggle('active', p.id === `panel-${name}`);
  });
}

// --- status / connection UI ------------------------------------------------

function setStatus(text) {
  els.statusLine.textContent = text;
}

// state: 'off' (nothing) | 'busy' (async op in flight, button disabled) |
// 'partial' (GATT/session up but not fully operational yet) | 'on' (ready to control)
function setConnectionUi(state) {
  if (state === undefined) {
    state = !session.connected ? 'off' : session.sessionKey && session.macLe ? 'on' : 'partial';
  }
  els.brandDot.className =
    'brand-dot' + (state === 'on' ? ' connected' : state === 'busy' || state === 'partial' ? ' connecting' : '');
  els.btnConnect.textContent = state === 'off' || state === 'busy' ? 'Conectar' : 'Desconectar';
  els.btnConnect.disabled = state === 'busy';

  const controlsEnabled = state === 'on';
  for (const el of [
    els.btnPower,
    els.sliderBrightness,
    els.colorPicker,
    els.sliderWhite,
    els.btnUseWhite,
    els.btnSaveFavorite,
  ]) {
    el.disabled = !controlsEnabled;
  }
  for (const btn of els.swatchesColor.querySelectorAll('button')) btn.disabled = !controlsEnabled;
  for (const btn of els.swatchesFavorites.querySelectorAll('button')) btn.disabled = !controlsEnabled;
  els.powerHint.textContent = controlsEnabled ? 'Lista para usar' : 'Conectá la lámpara para controlarla';
  els.btnTryLogin.disabled = !session.device;
  els.btnTestMac.disabled = !session.sessionKey;
  els.btnExploreGatt.disabled = !session.server;
}

// --- power / color / brightness / white -----------------------------------

let powerOn = false;

// Shows the real cálido/frío slider only for the Livarno profile; the generic
// profile (this lamp) controls white brightness with the main Brillo slider instead.
function updateProfileUi() {
  const isLivarno = currentProfile().key === 'livarno';
  els.whiteTempRow.style.display = isLivarno ? '' : 'none';
  els.whiteHint.style.display = isLivarno ? 'none' : '';
}

async function sendSafe(opcode, params, { quiet = false } = {}) {
  try {
    await session.send(opcode, params);
    return true;
  } catch (err) {
    if (!quiet) setStatus(`Error al enviar comando: ${err.message}`);
    logDiag(`Error enviando comando 0x${opcode.toString(16)}: ${err.message}`);
    return false;
  }
}

async function setPower(on) {
  powerOn = on;
  els.btnPower.setAttribute('aria-pressed', String(on));
  const { opcode, params } = currentProfile().power(on);
  await sendSafe(opcode, params);
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// --- Philco/Jingxun hardware note (see PROTOCOL.md) -------------------------
// On this specific lamp OP_GENERIC_BRIGHTNESS (0xD2) doesn't work (it just makes the
// lamp blink and snap back), and the "colour temperature" byte of 0xE2/0x05 is read
// as a plain white-channel brightness (0-100, not inverted, no real warm/cool control).
// So for the "generic" profile we never send 0xD2: brightness in colour mode is done by
// scaling R/G/B before sending, and brightness in white mode goes through 0xE2/0x05
// directly. The "livarno" profile is untouched — that firmware family genuinely has a
// combined brightness+colour packet and real Y/W colour temperature.

async function applyColor(hex) {
  settings.lastColor = hex;
  settings.lastMode = 'color';
  Store.set('lastColor', hex);
  Store.set('lastMode', 'color');
  const { r, g, b } = hexToRgb(hex);
  const brightness = Number(els.sliderBrightness.value);
  const prof = currentProfile();
  let opcode, params;
  if (prof.key === 'livarno') {
    ({ opcode, params } = prof.rgb(r, g, b, brightness));
  } else {
    const scale = brightness / 100;
    ({ opcode, params } = prof.rgb(Math.round(r * scale), Math.round(g * scale), Math.round(b * scale)));
  }
  await sendSafe(opcode, params, { quiet: true });
}

async function applyBrightness(value) {
  settings.lastBrightness = value;
  Store.set('lastBrightness', value);
  const prof = currentProfile();
  if (prof.key === 'livarno') {
    const { opcode, params } = prof.brightness(value);
    await sendSafe(opcode, params, { quiet: true });
    return;
  }
  // Generic profile: re-apply whatever mode is active at the new brightness level.
  if (settings.lastMode === 'white') {
    const { opcode, params } = prof.whiteLevel(value);
    await sendSafe(opcode, params, { quiet: true });
  } else {
    await applyColor(settings.lastColor);
  }
}

function whitePercentToKelvin(percent) {
  const prof = currentProfile();
  // slider: 0 = cálido, 100 = frío (natural UX); map onto the profile's Kelvin range.
  return Math.round(prof.minKelvin + (percent / 100) * (prof.maxKelvin - prof.minKelvin));
}

// Livarno profile only: real warm/cool colour temperature via the cálido/frío slider.
async function applyWhite(percent) {
  settings.lastWhite = percent;
  settings.lastMode = 'white';
  Store.set('lastWhite', percent);
  Store.set('lastMode', 'white');
  const kelvin = whitePercentToKelvin(percent);
  const prof = currentProfile();
  const { opcode, params } = prof.colorTemp(kelvin, {
    minKelvin: prof.minKelvin,
    maxKelvin: prof.maxKelvin,
    brightness: Number(els.sliderBrightness.value),
  });
  await sendSafe(opcode, params);
}

// Generic profile only: "blanco" is just the white channel at the current Brillo level.
async function useWhiteGeneric() {
  settings.lastMode = 'white';
  Store.set('lastMode', 'white');
  const { opcode, params } = currentProfile().whiteLevel(Number(els.sliderBrightness.value));
  await sendSafe(opcode, params);
}

// throttle helper for slider dragging
function throttled(fn, ms) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(pending);
      pending = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

const applyColorThrottled = throttled(applyColor, 90);
const applyBrightnessThrottled = throttled(applyBrightness, 90);
const applyWhiteThrottled = throttled(applyWhite, 90);

// --- swatches ------------------------------------------------------------

function renderColorSwatches() {
  els.swatchesColor.innerHTML = '';
  for (const hex of PRESET_COLORS) {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.style.background = hex;
    btn.disabled = !session.sessionKey;
    btn.title = hex;
    btn.addEventListener('click', () => {
      els.colorPicker.value = hex;
      applyColor(hex);
    });
    els.swatchesColor.appendChild(btn);
  }
}

function renderFavorites() {
  els.swatchesFavorites.innerHTML = '';
  const favs = settings.favorites || [];
  els.favoritesHint.style.display = favs.length ? 'none' : '';
  for (const hex of favs) {
    const btn = document.createElement('button');
    btn.className = 'swatch remove';
    btn.style.background = hex;
    btn.disabled = !session.sessionKey;
    btn.title = 'Tocar para aplicar · mantené presionado para borrar';
    btn.addEventListener('click', () => {
      els.colorPicker.value = hex;
      applyColor(hex);
    });
    let pressTimer;
    const startRemove = () => {
      pressTimer = setTimeout(() => {
        settings.favorites = favs.filter((f) => f !== hex);
        Store.set('favorites', settings.favorites);
        renderFavorites();
      }, 600);
    };
    const cancelRemove = () => clearTimeout(pressTimer);
    btn.addEventListener('pointerdown', startRemove);
    btn.addEventListener('pointerup', cancelRemove);
    btn.addEventListener('pointerleave', cancelRemove);
    els.swatchesFavorites.appendChild(btn);
  }
}

// --- wiring: control tab ------------------------------------------------------------

els.btnPower.addEventListener('click', () => setPower(!powerOn));

els.sliderBrightness.addEventListener('input', () => {
  const v = Number(els.sliderBrightness.value);
  els.brightnessValue.textContent = v + '%';
  els.sliderBrightness.style.setProperty('--fill', v + '%');
  applyBrightnessThrottled(v);
});
els.sliderBrightness.addEventListener('change', () => applyBrightness(Number(els.sliderBrightness.value)));

els.colorPicker.addEventListener('input', () => applyColorThrottled(els.colorPicker.value));
els.colorPicker.addEventListener('change', () => applyColor(els.colorPicker.value));

// Livarno profile only (hidden for "generic" — see updateProfileUi).
els.sliderWhite.addEventListener('input', () => {
  const v = Number(els.sliderWhite.value);
  els.sliderWhite.style.setProperty('--fill', v + '%');
  applyWhiteThrottled(v);
});
els.sliderWhite.addEventListener('change', () => applyWhite(Number(els.sliderWhite.value)));

els.btnUseWhite.addEventListener('click', () => {
  if (currentProfile().key === 'livarno') applyWhite(Number(els.sliderWhite.value));
  else useWhiteGeneric();
});

els.btnSaveFavorite.addEventListener('click', () => {
  const hex = els.colorPicker.value;
  if (!settings.favorites.includes(hex)) {
    settings.favorites = [...settings.favorites, hex];
    Store.set('favorites', settings.favorites);
    renderFavorites();
  }
});

// --- diagnostics tab ------------------------------------------------------------

function renderLoginAttempt(preset, ok, err) {
  const row = document.createElement('div');
  row.className = ok ? 'ok' : 'fail';
  row.textContent = `${ok ? '✓' : '✗'} ${preset.label} (${preset.name} / ${preset.password})` + (err ? ` — ${err}` : '');
  els.loginPresetsLog.prepend(row);
}

async function doScan(any) {
  try {
    setStatus(any ? 'Elegí la lámpara en la lista…' : 'Buscando lámpara Philco…');
    await (any ? session.requestDeviceAny() : session.requestDevice());
    Store.set('deviceId', session.device.id);
    logDiag(`Dispositivo elegido: ${session.device.name || '(sin nombre)'} [${session.device.id}]`);
    await session.connectGatt();
    logDiag('Conectado por GATT. Servicio Telink encontrado.');
    setStatus(`Conectado a ${session.device.name || 'la lámpara'}. Ahora probá las credenciales.`);
    setConnectionUi();
    els.btnTryLogin.disabled = false;
    els.btnExploreGatt.disabled = false;
  } catch (err) {
    logDiag(`Error al buscar/conectar: ${err.message}`);
    setStatus(`No se pudo conectar: ${err.message}`);
  }
}

els.btnScanFiltered.addEventListener('click', () => doScan(false));
els.btnScanAny.addEventListener('click', () => doScan(true));

function presetList() {
  const custom = { id: 'custom', label: 'Guardado en Ajustes', name: settings.meshName, password: settings.meshPassword, profile: settings.profile };
  const seen = new Set();
  const list = [];
  for (const p of [custom, ...CREDENTIAL_PRESETS]) {
    const k = p.name + '|' + p.password;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(p);
  }
  return list;
}

els.btnTryLogin.addEventListener('click', async () => {
  els.loginPresetsLog.innerHTML = '';
  els.btnTryLogin.disabled = true;
  try {
    const preset = await session.loginWithPresets(presetList(), (p, ok, err) => {
      renderLoginAttempt(p, ok, err?.message);
      logDiag(ok ? `"${p.label}" — OK` : `"${p.label}" — ${err?.message || 'falló'}`);
    });
    logDiag(`Login OK con "${preset.label}".`);
    settings.meshName = preset.name;
    settings.meshPassword = preset.password;
    settings.profile = preset.profile || settings.profile;
    Store.set('meshName', settings.meshName);
    Store.set('meshPassword', settings.meshPassword);
    Store.set('profile', settings.profile);
    syncSettingsFields();
    updateProfileUi();
    await session.enableNotifications();
    logDiag(`Notificaciones: ${session.notificationsEnabled ? 'activadas' : 'no disponibles (igual se puede controlar)'}`);
    if (settings.mac) {
      session.setMac(settings.mac);
      els.macInput.value = settings.mac;
      setStatus(`Conectado (${preset.label}).`);
    } else {
      setStatus(`Login OK. Ahora configurá la MAC (paso 3) para poder enviar comandos.`);
    }
    setConnectionUi();
    els.btnTestMac.disabled = false;
  } catch (err) {
    logDiag(`Ninguna credencial funcionó. Último error: ${err.message}`);
    setStatus(`No se pudo iniciar sesión: ${err.message}`);
  } finally {
    els.btnTryLogin.disabled = false;
  }
});

session.addEventListener('mac-detected', (ev) => {
  const mac = T.leToMac(ev.detail);
  els.macInput.value = mac;
  els.macDetectedHint.textContent = `MAC detectada automáticamente: ${mac} (típico justo después de un reset de fábrica).`;
  logDiag(`MAC detectada automáticamente: ${mac}`);
});

els.btnTestMac.addEventListener('click', async () => {
  const mac = els.macInput.value.trim();
  if (!mac) return;
  try {
    session.setMac(mac);
    logDiag(`Probando MAC ${mac}: apagando y prendiendo…`);
    await setPower(false);
    await new Promise((r) => setTimeout(r, 700));
    await setPower(true);
    settings.mac = mac;
    Store.set('mac', mac);
    els.setMac.value = mac;
    setConnectionUi();
    setStatus(`MAC guardada. Si la lámpara parpadeó, ¡listo! Si no, probá otra MAC.`);
  } catch (err) {
    logDiag(`Error probando MAC: ${err.message}`);
  }
});

els.btnExploreGatt.addEventListener('click', async () => {
  try {
    const svcs = await session.exploreGatt();
    els.gattDump.textContent = svcs
      .map((s) => `Servicio ${s.uuid}\n` + s.characteristics.map((c) => `  ${c.uuid}  [${c.properties.join(', ')}]`).join('\n'))
      .join('\n\n');
  } catch (err) {
    els.gattDump.textContent = 'Error: ' + err.message;
  }
});

session.addEventListener('raw-notify', (ev) => {
  logDiag(`Notificación cruda: ${T.toHex(ev.detail)}`);
});

// --- settings tab ------------------------------------------------------------

function syncSettingsFields() {
  els.setMeshName.value = settings.meshName;
  els.setMeshPassword.value = settings.meshPassword;
  els.setProfile.value = settings.profile;
  els.setMinKelvin.value = settings.minKelvin;
  els.setMaxKelvin.value = settings.maxKelvin;
  els.setMac.value = settings.mac || '';
}

els.btnSaveSettings.addEventListener('click', () => {
  settings.meshName = els.setMeshName.value.trim() || defaults.meshName;
  settings.meshPassword = els.setMeshPassword.value;
  settings.profile = els.setProfile.value;
  settings.minKelvin = Number(els.setMinKelvin.value) || defaults.minKelvin;
  settings.maxKelvin = Number(els.setMaxKelvin.value) || defaults.maxKelvin;
  settings.mac = els.setMac.value.trim() || null;
  for (const k of ['meshName', 'meshPassword', 'profile', 'minKelvin', 'maxKelvin', 'mac']) Store.set(k, settings[k]);
  if (settings.mac) session.setMac(settings.mac);
  updateProfileUi();
  setStatus('Ajustes guardados.');
});

els.btnForget.addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las credenciales, MAC y favoritos guardados en este navegador?')) return;
  await session.disconnect();
  for (const k of Object.keys(defaults)) Store.remove(k);
  settings = loadSettings();
  syncSettingsFields();
  updateProfileUi();
  renderFavorites();
  setConnectionUi();
  setStatus('Datos borrados. Volvé a buscar la lámpara desde Diagnóstico.');
});

// --- header connect button (full automatic flow) ------------------------------

els.btnConnect.addEventListener('click', async () => {
  if (session.connected) {
    await session.disconnect();
    setConnectionUi();
    setStatus('Desconectado.');
    return;
  }
  setConnectionUi('busy');
  try {
    if (session.device) {
      // Ya elegimos este dispositivo antes (se cayó la conexión) — reconectar sin
      // reabrir el selector de Bluetooth.
      setStatus('Reconectando…');
    } else {
      setStatus('Buscando lámpara…');
      // Sin filtro: algunas lámparas (confirmado con esta Philco) no siempre anuncian
      // el UUID corto 0x1910 que usaría el filtro, y entonces nunca aparecerían.
      await session.requestDeviceAny();
      Store.set('deviceId', session.device.id);
    }
    await runConnectSequence();
  } catch (err) {
    if (err.name === 'NotFoundError') {
      setStatus('Búsqueda cancelada.');
    } else {
      setStatus(`No se pudo conectar: ${err.message}. Probá desde la pestaña Diagnóstico.`);
    }
    setConnectionUi();
  }
});

async function runConnectSequence() {
  await session.connectGatt();
  const preset = await session.loginWithPresets(presetList());
  settings.meshName = preset.name;
  settings.meshPassword = preset.password;
  settings.profile = preset.profile || settings.profile;
  Store.set('meshName', settings.meshName);
  Store.set('meshPassword', settings.meshPassword);
  Store.set('profile', settings.profile);
  syncSettingsFields();
  updateProfileUi();
  await session.enableNotifications();
  if (!settings.mac) {
    setStatus('Conectado, pero falta configurar la MAC. Andá a la pestaña Diagnóstico (paso 3).');
    setConnectionUi();
    return;
  }
  session.setMac(settings.mac);
  setConnectionUi();
  setStatus(`Conectado (${preset.label}).`);
}

session.addEventListener('disconnected', () => {
  setConnectionUi();
  setStatus('Se perdió la conexión con la lámpara.');
});

// --- init ------------------------------------------------------------

function applyStoredUiState() {
  els.sliderBrightness.value = settings.lastBrightness;
  els.brightnessValue.textContent = settings.lastBrightness + '%';
  els.sliderBrightness.style.setProperty('--fill', settings.lastBrightness + '%');
  els.colorPicker.value = settings.lastColor;
  els.sliderWhite.value = settings.lastWhite;
  els.sliderWhite.style.setProperty('--fill', settings.lastWhite + '%');
  syncSettingsFields();
  updateProfileUi();
  renderColorSwatches();
  renderFavorites();
}

async function tryAutoReconnect() {
  if (!settings.deviceId || !navigator.bluetooth.getDevices) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((d) => d.id === settings.deviceId);
    if (!device) return;
    session.useDevice(device);
    setConnectionUi('busy');
    setStatus('Reconectando automáticamente…');
    await runConnectSequence();
  } catch (err) {
    setConnectionUi();
    setStatus('Tocá "Conectar" para vincular la lámpara.');
  }
}

function init() {
  applyStoredUiState();
  if (!bluetoothAvailable()) {
    setStatus('Este navegador no soporta Web Bluetooth. Usá Chrome o Edge en Android o PC.');
    els.btnConnect.disabled = true;
    els.btnScanFiltered.disabled = true;
    els.btnScanAny.disabled = true;
    return;
  }
  setConnectionUi();
  tryAutoReconnect();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

init();
