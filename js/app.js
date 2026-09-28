import * as T from './telink-crypto.js';
import { getProfile, CREDENTIAL_PRESETS } from './telink-profiles.js';
import { TelinkSession, bluetoothAvailable } from './ble.js';
import { hueToHex, rgbToHue, createHueRing } from './color-wheel.js';

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
  minKelvin: 2700,
  maxKelvin: 6500,
  mac: null,
  deviceId: null,
  favorites: [],
  lastColor: '#ff0000',
  lastHue: 0,
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
  wheelWrap: $('wheelWrap'),
  wheelRing: $('wheelRing'),
  wheelThumb: $('wheelThumb'),
  swatchesColor: $('swatchesColor'),
  sliderWhite: $('sliderWhite'),
  whiteTempRow: $('whiteTempRow'),
  whitePresets: $('whitePresets'),
  btnUseWhite: $('btnUseWhite'),
  btnMusicToggle: $('btnMusicToggle'),
  musicMeterFill: $('musicMeterFill'),
  musicHint: $('musicHint'),
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

// 12 colores parejos alrededor de la rueda (30° cada uno), igual que "Colores
// predeterminados" del manual (Rojo, Rojo Naranja, Naranja, ... Rojo Violeta).
const PRESET_HUES = Array.from({ length: 12 }, (_, i) => i * 30);

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
    els.btnMusicToggle,
    els.btnSaveFavorite,
  ]) {
    el.disabled = !controlsEnabled;
  }
  els.wheelWrap.dataset.disabled = String(!controlsEnabled);
  for (const btn of els.swatchesColor.querySelectorAll('button')) btn.disabled = !controlsEnabled;
  for (const btn of els.swatchesFavorites.querySelectorAll('button')) btn.disabled = !controlsEnabled;
  for (const btn of els.whitePresets.querySelectorAll('button')) btn.disabled = !controlsEnabled;
  els.powerHint.textContent = controlsEnabled ? 'Lista para usar' : 'Conectá la lámpara para controlarla';
  els.btnTryLogin.disabled = !session.device;
  els.btnTestMac.disabled = !session.sessionKey;
  els.btnExploreGatt.disabled = !session.server;
  if (!controlsEnabled) stopMusicMode({ silent: true });
}

// --- power / color / brightness / white -----------------------------------

let powerOn = false;

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

// Both profiles now use verified, independent opcodes for brightness/color/white —
// see PROTOCOL.md "Opcodes verificados desde la app original". No more scaling hacks.

async function applyColor(hex) {
  settings.lastColor = hex;
  settings.lastMode = 'color';
  Store.set('lastColor', hex);
  Store.set('lastMode', 'color');
  els.colorPicker.value = hex;
  const { r, g, b } = hexToRgb(hex);
  const prof = currentProfile();
  const { opcode, params } =
    prof.key === 'livarno' ? prof.rgb(r, g, b, Number(els.sliderBrightness.value)) : prof.rgb(r, g, b);
  await sendSafe(opcode, params, { quiet: true });
}

async function applyBrightness(value) {
  settings.lastBrightness = value;
  Store.set('lastBrightness', value);
  const { opcode, params } = currentProfile().brightness(value);
  await sendSafe(opcode, params, { quiet: true });
}

function whitePercentToKelvin(percent) {
  const prof = currentProfile();
  // slider: 0 = cálido, 100 = frío (natural UX); map onto the profile's Kelvin range.
  return Math.round(prof.minKelvin + (percent / 100) * (prof.maxKelvin - prof.minKelvin));
}

async function applyWhite(percent) {
  settings.lastWhite = percent;
  settings.lastMode = 'white';
  Store.set('lastWhite', percent);
  Store.set('lastMode', 'white');
  const prof = currentProfile();
  let opcode, params;
  if (prof.key === 'livarno') {
    ({ opcode, params } = prof.colorTempKelvin(whitePercentToKelvin(percent), {
      minKelvin: prof.minKelvin,
      maxKelvin: prof.maxKelvin,
      brightness: Number(els.sliderBrightness.value),
    }));
  } else {
    ({ opcode, params } = prof.colorTemp(percent)); // percent: 0=cálido, 100=frío
  }
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

// --- color wheel ------------------------------------------------------------

let currentHue = 0;

function setColorFromHue(hue, { commit = false } = {}) {
  currentHue = hue;
  const hex = hueToHex(hue);
  settings.lastHue = hue;
  Store.set('lastHue', hue);
  if (commit) applyColor(hex);
  else applyColorThrottled(hex);
}

const hueRing = createHueRing(
  els.wheelWrap,
  els.wheelRing,
  els.wheelThumb,
  (hue) => setColorFromHue(hue),
  (hue) => setColorFromHue(hue, { commit: true })
);

// --- swatches ------------------------------------------------------------

function renderColorSwatches() {
  els.swatchesColor.innerHTML = '';
  for (const hue of PRESET_HUES) {
    const hex = hueToHex(hue);
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.style.background = hex;
    btn.disabled = !session.sessionKey;
    btn.title = hex;
    btn.addEventListener('click', () => {
      hueRing.setThumbForHue(hue);
      setColorFromHue(hue, { commit: true });
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
      const { r, g, b } = hexToRgb(hex);
      hueRing.setThumbForHue(rgbToHue(r, g, b));
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

els.colorPicker.addEventListener('input', () => {
  const { r, g, b } = hexToRgb(els.colorPicker.value);
  hueRing.setThumbForHue(rgbToHue(r, g, b));
  applyColorThrottled(els.colorPicker.value);
});
els.colorPicker.addEventListener('change', () => applyColor(els.colorPicker.value));

// Perfil Livarno: usa colorTempKelvin (rango en Kelvin); perfil generic usa colorTemp(percent) directo.
els.sliderWhite.addEventListener('input', () => {
  const v = Number(els.sliderWhite.value);
  els.sliderWhite.style.setProperty('--fill', v + '%');
  applyWhiteThrottled(v);
});
els.sliderWhite.addEventListener('change', () => applyWhite(Number(els.sliderWhite.value)));

els.btnUseWhite.addEventListener('click', () => applyWhite(Number(els.sliderWhite.value)));

for (const btn of els.whitePresets.querySelectorAll('button[data-white]')) {
  btn.addEventListener('click', () => {
    const v = Number(btn.dataset.white);
    els.sliderWhite.value = v;
    els.sliderWhite.style.setProperty('--fill', v + '%');
    applyWhite(v);
  });
}

els.btnSaveFavorite.addEventListener('click', () => {
  const hex = els.colorPicker.value;
  if (!settings.favorites.includes(hex)) {
    settings.favorites = [...settings.favorites, hex];
    Store.set('favorites', settings.favorites);
    renderFavorites();
  }
});

// --- luces rítmicas (modo música) --------------------------------------------
//
// Usa el micrófono del celular (no hace falta cargar un archivo): analiza el volumen
// en tiempo real con la Web Audio API y manda el nivel + el color actual por opcode
// 0xD2 (LIGHT_ADJUST_LUM), igual que hace la app original al reproducir una canción.
// Ver PROTOCOL.md.

const music = { active: false, stream: null, audioCtx: null, analyser: null, data: null, timer: null };

function musicLevelFromAnalyser() {
  music.analyser.getByteFrequencyData(music.data);
  let max = 0;
  for (let i = 0; i < music.data.length; i++) if (music.data[i] > max) max = music.data[i];
  return Math.max(16, Math.min(100, Math.round((max / 128) * 100 + 1)));
}

async function startMusicMode() {
  if (music.active) return;
  try {
    music.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus('No se pudo acceder al micrófono: ' + err.message);
    return;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  music.audioCtx = new AudioCtx();
  const source = music.audioCtx.createMediaStreamSource(music.stream);
  music.analyser = music.audioCtx.createAnalyser();
  music.analyser.fftSize = 256;
  music.data = new Uint8Array(music.analyser.frequencyBinCount);
  source.connect(music.analyser);

  const { opcode: enterOp, params: enterParams } = currentProfile().musicEnter();
  await sendSafe(enterOp, enterParams);
  music.active = true;
  els.btnMusicToggle.textContent = 'Detener';
  els.btnMusicToggle.classList.add('btn-danger');
  els.btnMusicToggle.classList.remove('btn-ghost');

  music.timer = setInterval(async () => {
    if (!music.active) return;
    const level = musicLevelFromAnalyser();
    els.musicMeterFill.style.width = level + '%';
    const { r, g, b } = hexToRgb(els.colorPicker.value);
    const { opcode, params } = currentProfile().musicFrame(level, r, g, b);
    await sendSafe(opcode, params, { quiet: true });
  }, 160);
}

async function stopMusicMode({ silent = false } = {}) {
  if (!music.active) return;
  music.active = false;
  clearInterval(music.timer);
  music.timer = null;
  music.stream?.getTracks().forEach((t) => t.stop());
  music.stream = null;
  try {
    await music.audioCtx?.close();
  } catch {
    /* ignore */
  }
  music.audioCtx = null;
  els.musicMeterFill.style.width = '0%';
  els.btnMusicToggle.textContent = 'Escuchar micrófono';
  els.btnMusicToggle.classList.remove('btn-danger');
  els.btnMusicToggle.classList.add('btn-ghost');
  if (!silent && session.sessionKey) {
    const { opcode, params } = currentProfile().musicExit();
    await sendSafe(opcode, params, { quiet: true });
  }
}

els.btnMusicToggle.addEventListener('click', () => {
  if (music.active) stopMusicMode();
  else startMusicMode();
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
  setStatus('Ajustes guardados.');
});

els.btnForget.addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las credenciales, MAC y favoritos guardados en este navegador?')) return;
  await session.disconnect();
  for (const k of Object.keys(defaults)) Store.remove(k);
  settings = loadSettings();
  syncSettingsFields();
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
  currentHue = Number(settings.lastHue) || 0;
  hueRing.setThumbForHue(currentHue);
  els.sliderWhite.value = settings.lastWhite;
  els.sliderWhite.style.setProperty('--fill', settings.lastWhite + '%');
  syncSettingsFields();
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
