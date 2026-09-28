// Hue-ring colour picker (angle = hue, full saturation/value), matching the "Paleta"
// wheel in the original app's manual: a coloured ring with a hollow centre and a
// single draggable indicator — no separate saturation control (brightness is a
// distinct slider elsewhere in the UI, same as the manual).

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hueToHex(h) {
  const { r, g, b } = hsvToRgb(h, 1, 1);
  return rgbToHex(r, g, b);
}

/** Best-effort hue (0-360) for positioning the ring thumb on an arbitrary RGB colour. */
export function rgbToHue(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * Wires up a ring element as a hue picker.
 * @param {HTMLElement} ring - the coloured ring element (conic-gradient background)
 * @param {HTMLElement} thumb - the small indicator dot, positioned absolutely inside `wrap`
 * @param {HTMLElement} wrap - the positioning container (ring + thumb share this parent)
 * @param {(hue: number) => void} onChange - called with hue in [0, 360) while dragging
 * @param {(hue: number) => void} [onCommit] - called once when the drag ends
 */
export function createHueRing(wrap, ring, thumb, onChange, onCommit) {
  let dragging = false;

  function setThumbForHue(hue) {
    const rect = wrap.getBoundingClientRect();
    const radius = rect.width / 2 - thumb.offsetWidth / 2 - 4;
    const rad = ((hue - 90) * Math.PI) / 180;
    const cx = rect.width / 2 + radius * Math.cos(rad);
    const cy = rect.height / 2 + radius * Math.sin(rad);
    thumb.style.left = cx + 'px';
    thumb.style.top = cy + 'px';
  }

  function hueFromEvent(ev) {
    const rect = wrap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = ev.clientX - cx;
    const dy = ev.clientY - cy;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    return ((deg % 360) + 360) % 360;
  }

  function handleMove(ev) {
    if (!dragging) return;
    const hue = hueFromEvent(ev);
    setThumbForHue(hue);
    onChange(hue);
  }

  wrap.addEventListener('pointerdown', (ev) => {
    if (wrap.dataset.disabled === 'true') return;
    dragging = true;
    wrap.setPointerCapture(ev.pointerId);
    handleMove(ev);
  });
  wrap.addEventListener('pointermove', handleMove);
  wrap.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    onCommit?.(hueFromEvent(ev));
  });
  wrap.addEventListener('pointercancel', () => {
    dragging = false;
  });

  return { setThumbForHue };
}
