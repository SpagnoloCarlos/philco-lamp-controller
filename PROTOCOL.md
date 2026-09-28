# Protocolo: Telink BLE Mesh v1

La lámpara **Philco Smart Color** (Newsan, ~2018) se controla originalmente con la app
"Philco Smart Color" (paquete `com.jingxun.smarthome.tospo_philco`, del fabricante chino
Shenzhen Jingxun). Esa app ya no está en Play Store. El módulo BLE de Jingxun (p.ej. su
placa 7581-01) está basado en un chip **Telink** (TLSR82xx), y la app implementa el
protocolo estándar **"Telink Mesh v1"** que usan decenas de marcas de lamparitas E27
RGB+CCT baratas ("Fulife", "Mesh Lamp", "V-TAC", "MOES", "Zengge", etc.) — no es un
protocolo propietario de Philco.

No hubo necesidad de decompilar el APK de Philco: el protocolo ya está públicamente
reverseingenieriado, verificado contra hardware real y con tests automatizados por dos
proyectos independientes de Home Assistant:

- **kernelorg/ha-telink-mesh** — `custom_components/telink_mesh/protocol.py` +
  `tests/test_protocol.py` (tests cruzados contra una reimplementación literal de
  **python-dimond**, de Google, Apache-2.0). Esta es la fuente principal que usamos acá.
- **vik-pfqld/blisslights-telink-ha** — `PROTOCOL.md`, con el volcado byte a byte del
  handshake y la criptografía, sacado directamente del smali de la app Android
  (`com/telink/crypto/AES.java`, `LightController.java`), útil como segunda fuente para
  confirmar cada fórmula.
- **vpaeder/telinkpp** — mapeo de temperatura de color (Y/W) para el perfil "Livarno".

`js/telink-crypto.js` y `js/telink-profiles.js` son un port línea por línea de
`protocol.py`. `test/verify.mjs` corre los **mismos vectores de test** que
`test_protocol.py` (más una reimplementación independiente con el AES nativo de Node)
y confirma que el puerto a JavaScript da bit a bit el mismo resultado. Correr:

```
node test/verify.mjs
```

## GATT

Servicio `00010203-0405-0607-0809-0a0b0c0d1910`:

| Característica | UUID (sufijo) | Uso |
|---|---|---|
| PAIR  | `…1914` | login / handshake (write + read) |
| COMMAND | `…1912` | paquetes cifrados hacia la lámpara |
| NOTIFY | `…1911` | notificaciones cifradas desde la lámpara |
| OTA | `…1913` | actualización de firmware (no usado) |

El anuncio BLE lleva el UUID corto de servicio `0x1910` (distinto del UUID de 128 bits
de arriba, por convención del SDK de Telink).

## Credenciales de fábrica

El SDK de Telink trae por defecto `telink_mesh1` / `123`. Muchas marcas white-label
(incluida la familia "Fulife/Mesh Lamp" que más se parece a esta lámpara) las cambian a
`Fulife` / `2846`. La app prueba ambas (y `telink_mesh0`/`123`) en cadena al conectar.
Si la lámpara nunca fue emparejada con la app original, o si se restauró a fábrica
(apagar/prender varias veces seguidas con la llave de luz), debería aceptar alguna de
estas. Si la app original ya la emparejó y no se reseteó, el nombre de malla cambia a
un string hexadecimal derivado del teléfono — en ese caso hay que resetear la lámpara.

## Login (handshake)

1. `key0 = pad16(nombre) XOR pad16(contraseña)` (16 bytes, rellenado con ceros).
2. `rand8` = 8 bytes aleatorios.
3. `auth = telinkEncrypt(rand8 ++ zeros(8), key0)`.
4. Escribir 17 bytes a `…1914`: `[0x0C, rand8(8), auth[0:8]]`.
5. Leer `…1914`: `[op, r2(8), check(8)]`. `op == 0x0D` → éxito; `0x0E` → credenciales
   incorrectas.
6. `sessionKey = telinkEncrypt(key0, rand8 ++ r2)`.

`telinkEncrypt(key, data)` = AES-128-ECB con la clave y los datos **invertidos byte a
byte**, y la salida también invertida (rareza de Telink, típica de firmware little-endian
mal portado). Sin padding: siempre opera sobre bloques de 16 bytes exactos.

## Paquete de comando (20 bytes)

```
byte  0-2   número de secuencia (queda en claro tras cifrar)
byte  3-4   MAC de autenticación (CBC-MAC), la calcula encryptPacket()
byte  5-6   dirección mesh destino (0x0000 = "el nodo al que estoy conectado")
byte  7     opcode
byte  8-9   vendor id, 0x0211 para el SDK genérico de Telink
byte 10-19  parámetros (hasta 10 bytes, rellenados con cero)
```

El cifrado combina **CBC-MAC** (autenticación, sobre `data[5..19]`) + **CTR** (cifrado
de flujo, mismo rango) usando como nonce/IV una mezcla de los primeros bytes de la
**dirección MAC real de la lámpara** + el número de secuencia. Ver `encryptPacket` /
`decryptPacket` en `telink-crypto.js` para el detalle byte a byte (idéntico a
`protocol.py`).

### ⚠️ El problema de la MAC en una web app

Esta es la única pieza del protocolo que no depende de un handshake: el firmware mezcla
su propia dirección BLE real en el nonce. Una app nativa Android puede leerla
directamente de la API de BLE del sistema — pero **Chrome, por privacidad, nunca expone
la MAC real a una página web** (`BluetoothDevice.id` es un token opaco, y
`watchAdvertisements()` con datos de fabricante no está disponible en Chrome para
Android). Por eso la pestaña **Diagnóstico** pide la MAC:

- Se intenta detectarla sola escuchando una notificación sin cifrar de tipo "address
  report" (opcode `0xE1`) que algunos firmwares Telink emiten una sola vez, justo
  después de un reset de fábrica — que es exactamente el estado en el que quedó la
  lámpara del usuario.
- Si no aparece, se ingresa a mano (por ejemplo escaneando con la app gratuita
  **nRF Connect** en Android, que sí puede leer la MAC real) y se verifica con el botón
  "Probar" (hace parpadear la lámpara).

## Opcodes verificados desde la app original (perfil `generic`)

La primera versión de este documento asumía los opcodes "genéricos" de
`ha-telink-mesh` (pensados para lámparas Fulife/Mesh Lamp). Probando contra una
Philco Smart Color real hubo comportamientos raros (brillo que solo hacía parpadear
la lámpara, "temperatura de color" que en realidad movía el brillo) — así que en vez
de seguir adivinando, se **decompiló el APK original** (`Philco Smart Color`
v1.6.292, paquete `com.jingxun.smarthome.tospo_philco`, con `jadx`) y se extrajeron
los opcodes reales de su bundle de React Native (`assets/index.android.bundle`),
cruzados contra el SDK nativo de Telink que trae empaquetado
(`com/telink/bluetooth/light/LightController.java`, etc.). La tabla de abajo es la
real, no una suposición:

| Función | Opcode (`Command`) | Subcomando (`AddOns`) | Parámetros |
|---|---|---|---|
| Encender/apagar | `0xD0` (`POWER`) | `0`=OFF, `1`=ON | `[on, delayLow, delayHigh]` |
| Brillo | `0xE2` (`LIGHT_ADJUST`) | `5` (`BRIGHTNESS`) | `[5, brillo 0-100]` |
| Color RGB | `0xE2` | `4` (`COLOR_RGB`) | `[4, R, G, B]` |
| Temperatura de color | `0xE2` | `6` (`COLOR_TEMP`) | `[6, blancoFrío 0-255, blancoCálido 0-255]` |
| RGB + blanco frío/cálido | `0xE2` | `9` (`COLOR_RGBCW`) | `[9, R, G, B, frío, cálido]` |
| Todo junto | `0xE2` | `0` (`ALL`) | `[0, R, G, B, frío, cálido, brillo]` |
| Reset de red (requiere estar logueado) | `0xE3` (`RESET_DEVICE`) | — | `[1]` |
| Modo música — entrar/salir | `0xD2` (`LIGHT_ADJUST_LUM`) | — | `[254]` entrar, `[255]` salir |
| Modo música — cada cuadro | `0xD2` | — | `[nivel 16-100, R, G, B, 0]` |
| Estado online (notificación) | `0xDC` (`STATUS_REPORT`) | — | 4 bytes por nodo: `[id, seq, brillo, reservado]` |

Detalles importantes que explican los síntomas anteriores:

- **`0xD2` nunca fue "brillo".** Es el opcode `LIGHT_ADJUST_LUM`, exclusivo del modo
  música. Mandarle un byte de brillo cualquiera (como hacía la v1 de esta app, copiando
  el perfil genérico de `ha-telink-mesh`) lo interpreta como un cuadro de música mal
  formado → la lámpara hace un resync visible (parpadeo) sin aplicar nada.
- **El brillo real está en `0xE2` subcomando `5`, no en `0xD2`.** Resulta que el valor
  que antes mandábamos como "temperatura de color" (`0xE2`, `[0x05, ...]`) en realidad
  era brillo — por eso el slider cálido/frío movía la intensidad en vez del tono.
- **La temperatura de color real es el subcomando `6`**, con dos bytes independientes
  (blanco frío 0-255, blanco cálido 0-255) — sí soporta cálido/frío real, contra lo que
  se había concluido antes. La app original convierte un slider 0-100 así:
  `frío = round(pct/100*255)`, `cálido = 255 - frío` (0% = full cálido, 100% = full frío).
- **Modo música**: la app arma un frame `[nivel, R, G, B, 0]` cada ~160 ms mientras
  escucha el micrófono, donde `nivel` sale de la banda de frecuencia más fuerte
  (`round(maxByte/128*100 + 1)`, acotado a `[16, 100]`) y R/G/B es el color
  seleccionado en la rueda (no cambia con la música, solo el brillo pulsa).

`js/telink-crypto.js` (constantes `OP_LIGHT_ADJUST`, `LIGHT_ADJUST.*`,
`OP_LIGHT_ADJUST_LUM`, `OP_RESET_DEVICE`) y `js/telink-profiles.js`
(`GenericProfile`) implementan esta tabla tal cual, con tests en
`test/verify.mjs` para cada opcode.

También existe un perfil `livarno` (Lidl Livarno/Briloner, opcodes `0xF0`/`0xF1`, con
brillo+color combinados en un solo paquete y CCT vía canales Y/W) sin tocar, por si
algún día hace falta para otro producto — seleccionable en Ajustes.

## Fuentes

- https://github.com/kernelorg/ha-telink-mesh (protocol.py, test_protocol.py, const.py)
  — base del cifrado/handshake (login, sesión, cifrado de paquetes); los opcodes de
  control de luz de ese proyecto quedaron reemplazados por los de arriba.
- https://github.com/vik-pfqld/blisslights-telink-ha (PROTOCOL.md) — segunda fuente
  para verificar el cifrado byte a byte.
- https://github.com/vpaeder/telinkpp
- python-dimond (Google, Apache-2.0) — referencia original del handshake/cifrado
- **APK oficial "Philco Smart Color" v1.6.292** (`com.jingxun.smarthome.tospo_philco`,
  Newsan/Jingxun), decompilado con `jadx` — fuente de la tabla de opcodes de arriba
  (`assets/index.android.bundle` + `com/telink/bluetooth/light/*.java`). No se
  redistribuye el APK ni el código decompilado en este repo, solo lo que se aprendió
  de él.
