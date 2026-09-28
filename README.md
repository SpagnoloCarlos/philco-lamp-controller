# Philco Smart Color — control web (no oficial)

Web app (PWA) para controlar la lámpara **Philco Smart Color** por Bluetooth, ya que la
app oficial se bajó de Play Store. No usa ningún servidor: corre 100% en el navegador y
habla directo con la lámpara por **Web Bluetooth**.

Requiere **Chrome o Edge** (Android o PC con Bluetooth). **No funciona en iPhone/Safari**
(Web Bluetooth no está soportado ahí). Ver `PROTOCOL.md` para el detalle técnico del
protocolo (Telink BLE Mesh v1, opcodes verificados desde la app original) y sus fuentes.

**Funciones:** encender/apagar, brillo, rueda de color (paleta + 12 colores
predeterminados), blanco con temperatura cálido/frío real, favoritos, y luces
rítmicas que pulsan con el micrófono del celular al ritmo de la música.

## Probarla desde el celular (durante desarrollo)

Web Bluetooth exige HTTPS **o** `localhost`. Para probar en el Android sin publicar nada
todavía, se usa `adb` para mapear el puerto del servidor local de la PC como si fuera
`localhost` dentro del celular:

1. Activar "Depuración USB" en el Android (Ajustes → Opciones de desarrollador) y
   conectarlo por cable a la PC.
2. En la PC, iniciar el servidor local:
   ```
   node server.mjs
   ```
3. En otra terminal (con `adb` instalado — viene con Android Studio / platform-tools):
   ```
   adb reverse tcp:8080 tcp:8080
   ```
4. En Chrome del Android, abrir `http://localhost:8080`.

Cada vez que se reinicia el cable/adb hay que repetir el `adb reverse`.

## Primer uso (con la lámpara ya en modo de fábrica)

1. Pestaña **Diagnóstico** → "Buscar lámpara Philco" y elegirla en la lista que abre
   Chrome.
2. "Probar credenciales" — prueba sola las contraseñas de fábrica más comunes.
3. Paso 3, la MAC: puede aparecer sola ("MAC detectada automáticamente"). Si no aparece,
   escanear con la app gratuita **nRF Connect** (Play Store), buscar el dispositivo de la
   lámpara y copiar su dirección MAC ahí a mano. Tocar "Probar (parpadea)": si la lámpara
   parpadea, la MAC es correcta y queda guardada.
4. Volver a la pestaña **Control** — ya debería responder.

Las próximas veces alcanza con tocar "Conectar" arriba; la app recuerda las credenciales,
la MAC y (si el navegador lo permite) reconecta sola al abrir.

## Instalarla como app

En Chrome Android: menú ⋮ → "Agregar a pantalla de inicio". Queda como un ícono aparte,
sin la barra de direcciones.

## Publicarla (para no depender de `adb reverse`)

La forma más simple es subir esta carpeta tal cual a **GitHub Pages** o **Netlify**
(cualquiera de los dos sirve HTTPS gratis). No se hizo automáticamente — decidí vos si
querés que lo prepare (inicializar el repo git, etc.).

## Estructura

```
index.html, styles.css        interfaz
js/telink-crypto.js           cifrado/protocolo Telink Mesh (con tests, ver PROTOCOL.md)
js/telink-profiles.js         mapeo encendido/brillo/color/blanco/música → comandos
js/color-wheel.js             rueda de color (selector de tono tipo anillo)
js/ble.js                     transporte Web Bluetooth
js/app.js                     estado de la UI, ajustes, flujo de conexión, modo música
manifest.webmanifest, sw.js   PWA instalable / caché offline del shell (network-first)
test/verify.mjs               valida el protocolo contra vectores de test reales
server.mjs                    servidor estático mínimo para pruebas locales
```

## Si no responde

- Perfil equivocado: en Ajustes, probar el perfil "Livarno / Briloner" en vez del
  genérico (el genérico ya trae los opcodes verificados de esta lámpara).
- Luces rítmicas: pide permiso de micrófono la primera vez — si lo rechazaste, hay que
  habilitarlo desde el ícono de candado/sitio en Chrome y recargar.
- La lámpara ya fue emparejada por la app vieja o por esta misma (no está en modo
  fábrica): resetearla desde la llave de luz — 3 ciclos de menos de 2 seg seguidos de
  2 ciclos de más de 5 seg (revisar el manual en papel) — para volver a las
  credenciales por defecto. Si dejó de aceptarlas incluso después del reset, puede que
  el firmware ya no vuelva a modo fábrica solo con esa secuencia; ver la nota al final
  de `PROTOCOL.md`.
