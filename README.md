# boletin

Genera un informe de notas desde el portal de apoderados iSAMS. Un comando:
token → API → informe en HTML, Markdown o CSV.

Source: https://claude.ai/cowork/project/01a01b7e-25f4-7330-934f-cd05486bc697

```bash
npm install                          # requiere Node 20+
export ISAMS_TOKEN="eyJhbGciOi..."   # ver "Obtener el token"
npm run boletin -- --format html notas.html
```

Todo lo que va después de `--` son argumentos del programa.
Para verificar que quedó bien instalado, sin necesitar token:

```bash
npm run check                        # 42 pruebas
npm run boletin -- --format md --from-raw test/fixture.raw.json
```

## Uso

```
npm run boletin -- --format <html|md|csv> [--output archivo]
npm run boletin -- auth refresh    # renueva si hace falta y persiste
npm run boletin -- auth status     # estado de la cadena; no consume nada
npm run boletin -- auth bootstrap  # cómo sacar credenciales del navegador
```

| Opción                   |                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `--format <f>`           | `html`, `md`, `csv` o `email`. **Requerido.** Ver "Formatos".                                               |
| `[salida]`               | Archivo de salida. Si se omite, escribe a stdout.                                                            |
| `--output <archivo>`     | Archivo de salida. También se acepta como posicional.                                                        |
| `--token <jwt>`          | Access token suelto. Mejor `ISAMS_TOKEN`: en `--token` queda en el historial del shell y es visible en `ps`. |
| `--refresh-token <jwt>`  | Habilita la renovación. Variable: `ISAMS_REFRESH_TOKEN`.                                                     |
| `--token-file <ruta>`    | Credenciales en JSON, reescrito en cada renovación. Absoluta o relativa. Por defecto `credenciales.json`.    |
| `--tenant <id>`          | Solo si tienes únicamente el refresh token, que es opaco.                                                    |
| `--no-refresh`           | No renovar aunque haya refresh token.                                                                        |
| `--journal <ruta>`       | Bitácora de la cadena. Por defecto, hermana del archivo de credenciales.                                     |
| `--trigger <t>`          | `manual` o `scheduled`. Queda anotado en la bitácora. Por defecto `manual`.                                  |
| `--parents-path <lista>` | Lista opaca del apoderado. Por defecto `1,9,8,4,7,6`.                                                        |
| `--profile <id>`         | Perfil de interpretación. Por defecto, según el tenant del token.                                            |
| `--year <n>`             | Año académico para el título.                                                                                |
| `--save-raw <archivo>`   | Guarda la extracción cruda.                                                                                  |
| `--from-raw <archivo>`   | Lee de un archivo guardado en vez de llamar a la API. No necesita token.                                     |
| `--model <archivo>`      | Guarda además el `ReportModel` en JSON.                                                                      |
| `--delay <ms>`           | Pausa entre llamadas. `0` por defecto: no se observaron cabeceras de rate limit.                             |
| `--strict`               | Sale con código 1 si hay avisos de severidad `error`.                                                        |
| `--verbose`              | Todo el detalle: tenant, libros y columnas por alumno, control de calidad y avisos `warn`.                   |
| `--quiet`                | Solo `stable-md5`. No silencia `--strict`.                                                                   |

El progreso y los avisos van a **stderr**; el informe a stdout. Se puede pipear.

Por defecto la corrida dice lo mínimo —por quién va, qué escribió y la huella:

```
Extrayendo datos de Alexander…
Extrayendo datos de Matilda…
Escrito sandbox/one.html (41754 bytes).
stable-md5: c36e7321df1f2ace9f14e3d16f9484d1
```

Lo que **no** se esconde nunca es que el informe no sea confiable: un periodo
que ningún modelo reproduce se avisa igual, con o sin `--verbose`. El HTML no
lleva línea de control de calidad adentro, así que para ese formato esta es la
única señal que hay.

## Credenciales

Hay **dos** tokens y hacen cosas distintas:

|                 | Dura        | Para qué                                              |
| --------------- | ----------- | ----------------------------------------------------- |
| `access_token`  | 1 hora      | Consultar la API de datos.                            |
| `refresh_token` | sin medir*  | Obtener access tokens nuevos sin volver al navegador. |

\* Cuánto vive la cadena —deslizante o absoluta— no está medido, así que no hay
número que dar. La bitácora lo responde con el tiempo, en `chainAgeSec`.

### Bootstrap: sacar ambos del navegador

Se hace **una sola vez**. Estos mismos pasos los imprime el CLI —con la ruta que
le pasaste ya sustituida— tanto en `auth bootstrap` como en cualquier error que
un bootstrap resuelva, así que no hace falta volver acá:

```bash
npm run boletin -- auth bootstrap --token-file /ruta/credenciales.json
```

Abre una ventana **de incógnito**, entra al portal y ejecuta en la consola:

```js
;(() => {
  const k = Object.keys(sessionStorage).find(k => k.startsWith("oidc.user"))
  if (!k) {
    alert("No se encontró la sesión OIDC. ¿Iniciaste sesión en el portal?")
    return
  }
  const o = JSON.parse(sessionStorage[k])
  copy(JSON.stringify({
    accessToken: o.access_token,
    refreshToken: o.refresh_token,
    tenant: location.hostname.split(".")[0],
  }, null, 2))
  sessionStorage.removeItem(k)
  alert(
    "Credenciales copiadas al portapapeles.\n\n" +
    "Al cerrar este aviso la pestaña quedará en blanco. Es a propósito: " +
    "evita que el portal siga renovando el token y te lo invalide.\n\n" +
    "Guarda el portapapeles como archivo de credenciales (NO lo pegues en el chat)."
  )
  location.replace("about:blank")
})()
```

La pestaña en blanco es el objetivo del snippet, no un efecto colateral. El
portal renueva su token solo, en silencio, cada pocos minutos; mientras esa
pestaña viva compite por la misma cadena y te invalida la copia. Borrar la clave
de `sessionStorage` no alcanza —oidc-client-ts también tiene el usuario en
memoria y un renew ya agendado igual se dispara—, así que además hay que
destruir el contexto JS de la página. `location.replace` hace eso y de paso
impide que el botón Atrás resucite la sesión. `window.close()` no sirve: Chrome
solo lo permite en ventanas abiertas por script.

**No hagas logout.** El logout llama a `/connect/endsession` y con alta
probabilidad revoca la cadena, inutilizando lo que acabas de copiar.

Guarda el portapapeles sin que pase por ningún chat:

```bash
pbpaste > credenciales.json          # macOS
Get-Clipboard > credenciales.json    # PowerShell
```

```bash
npm run boletin -- --format html --token-file credenciales.json notas.html
```

Si el access token está vencido, se renueva solo y el archivo se reescribe.

### Rotación

Cada renovación devuelve un refresh token nuevo e **invalida el anterior**. De
ahí salen cuatro consecuencias que no son opcionales:

1. El almacén tiene que ser **escribible**. Un refresh token en una variable de
   entorno fija o en un secreto de solo lectura funciona una vez y después falla.
2. El token nuevo se persiste **antes** de tocar la API de datos. Si el proceso
   muere entremedio, la cadena se rompe.
3. `invalid_grant` es **terminal**, no transitorio. No reintentar: rehacer el
   bootstrap.
4. Una sola cadena, un solo consumidor. No dejes el portal abierto mientras corre.

### Cómo termina una renovación

Todo intento cae en exactamente uno de tres estados, porque piden cosas
distintas de quien llama:

| Estado          | Cuándo                                                        | El archivo             | Salida |
| --------------- | ------------------------------------------------------------- | ---------------------- | ------ |
| `ok`            | 2xx con `refresh_token`                                       | se reescribe rotado    | `0`    |
| `dead`          | HTTP 400 `invalid_grant`                                      | queda intacto          | `3`    |
| `indeterminate` | error de red, 5xx, cuerpo ilegible, o 2xx sin `refresh_token` | se marca `suspect`     | `5`    |

La distinción que importa es `dead` contra `indeterminate`. La primera es una
afirmación del servidor sobre este token: no reintentes, rehaz el bootstrap. La
segunda es la **ausencia** de respuesta: el servidor pudo haber rotado la cadena
y la respuesta perderse en el camino, así que el token del archivo puede estar
vivo o muerto y no hay forma local de saberlo. Por eso queda marcado, y por eso
la corrida siguiente lo dice antes de hacer nada.

### Bitácora

Cada interacción con el endpoint de tokens deja una línea JSONL junto al archivo
de credenciales (`credenciales.journal.jsonl`, o donde diga `--journal`). Existe
porque la causa de un `invalid_grant` no es reconstruible después: para cuando
el fallo aparece, el estado que lo explicaba ya fue sobrescrito.

Nunca guarda un token completo —solo colas de 6 caracteres—, rota a 200 líneas,
y un fallo al escribirla avisa por stderr pero jamás voltea la corrida.

`chainAgeSec` acumula la edad real de la cadena medida desde el `auth_time` del
access token. **Cuánto vive una cadena de refresh no está medido**: no hay número
que afirmar en el código ni en la documentación hasta que la bitácora lo diga.

### Diagnóstico

```bash
npm run boletin -- auth status --token-file credenciales.json
```

```
tenant             britishroyal
access token       vence en 34 min (2026-08-20T13:12:04Z)
auth_time          2026-08-19T18:02:11Z  (edad de la cadena: 18h 36m)
refresh token      …8f2a1c
estado             ok
última renovación  2026-08-20T12:38:04Z  (ok)
renovaciones       14 ok · 0 muertas · 1 indeterminada  (últimos 30 días)
```

Solo lee: no llama a la red, no consume ni rota nada, y no imprime más que colas
de 6 caracteres. Se puede correr siempre, incluso mientras intentas averiguar
por qué falló otra cosa.

### Una corrida suelta

Con un access token recién copiado, sin renovación:

```bash
export ISAMS_TOKEN="eyJhbGciOi..."
npm run boletin -- --format html --output notas.html
```

Si `--parents-path` por defecto no funciona, sácalo de la pestaña Network:
es la lista de enteros al final de la URL `…/students/portal/parents/…`.

### Los tres formatos, una sola extracción

El token dura una hora y la extracción son 26 peticiones. Para no repetirla:

```bash
npm run boletin -- --format html --save-raw datos.json notas.html
npm run boletin -- --format csv  --from-raw datos.json notas.csv
npm run boletin -- --format md   --from-raw datos.json notas.md
```

`datos.json` no contiene datos personales (ver abajo).

Los tres formatos llevan los mismos datos con distinta densidad. `html` es la
vista para leer: matriz completa, una columna por evaluación, con color y
tooltips. `md` es la misma matriz en tablas de datos, seguida de una tabla por
asignatura con el bloque, el peso y la nota de cada evaluación: pensado para que
lo lea otro programa o un modelo. `csv` es una fila por nota.

### Saber si un informe cambió

Cada corrida imprime a stderr una línea:

```
stable-md5: c36e7321df1f2ace9f14e3d16f9484d1
```

Es el md5 del contenido con la fecha de extracción normalizada. El HTML lleva
impresa esa fecha, así que el md5 del archivo cambia en cada corrida aunque las
notas sean idénticas; quien compara termina recortando la fecha a mano, y ese
recorte es frágil. Esto lo evita: misma data, misma huella.

```bash
$ npm run boletin -- --format html --from-raw datos.json --output a.html --quiet
stable-md5: c36e7321df1f2ace9f14e3d16f9484d1
```

Se mueve si cambia cualquier nota, promedio, asignatura o aviso, y también si
cambia el renderizador —la pregunta que responde es "¿es este el mismo archivo
que ya tengo?"—. Cada formato tiene la suya. `--quiet` no la silencia: quien
automatiza es justamente quien la necesita.

**No coincide con `md5sum archivo`**, a propósito.

### El formato `email`

`--format email` emite el informe para el **cuerpo** de un correo. No es el HTML
de siempre con el CSS movido: es otro documento, porque un cliente de correo no
es un navegador. Comprobado:

| Lo que usa el HTML web | Qué pasa en el correo |
| ---------------------- | --------------------- |
| `<style>` de 6,6 KB | Gmail borra el bloque **entero** si pasa de ~8 KB, si algo no le gusta, o si adentro hay un `background-image: url(...)` |
| `var(--…)` ×50 | Gmail soporta `var()` pero **no la declaración**: los colores quedan sin valor |
| `:hover` con 167 tooltips | No existe en correo. Es lo único que dice qué evaluación es cada columna numerada |
| `display:flex`, `grid`, `position` | Outlook de escritorio usa el motor de Word: no los soporta |
| `overflow-x` para la tabla ancha | No hay scroll interno en un correo: la tabla se corta |

Por eso el formato `email` va con estilos en línea en cada elemento, colores
literales y maquetación de tablas, sin un solo bloque `<style>` que Gmail pueda
borrar.

Es **la misma matriz del HTML**: una columna por evaluación agrupada por
periodo, el promedio de cada periodo, el final a la derecha, el fondo gris del
bloque que más pesa y el rojo bajo la nota de aprobación. Lo único que no viaja
son los tooltips —el HTML esconde ahí el nombre de cada evaluación y en correo
no existen—, así que las columnas quedan numeradas y el pie remite al informe
HTML para esa correspondencia. No dice "adjunto": si va adjunto o no lo decide
quien envía, y el CLI no tiene cómo saberlo.

El tamaño importa: Gmail recorta el mensaje cerca de los 102 KB y no avisa. Con
dos alumnos el cuerpo pesa ~77 KB, así que la familia grande es el caso que hay
que vigilar; el CLI avisa pasados los 90 KB.

```bash
npm run boletin -- --format email  --from-raw datos.json --output cuerpo.html
npm run boletin -- --format html   --from-raw datos.json --output adjunto.html
```

## Qué hace

```
API iSAMS ─[extract]─▶ RawExtract ─[interpret]─▶ ReportModel ─[render]─▶ salida
             §1–9                   §10 + perfil                html · md · csv
             agnóstico              según colegio
```

Ninguna etapa usa un modelo de lenguaje: los mismos datos producen el mismo
archivo, byte a byte.

**Datos personales.** La API devuelve ~59 campos por estudiante; la extracción
conserva 4 y descarta el resto —incluido `schoolId`, que equivale a un
identificador nacional de un menor— antes de que nada se escriba a disco.

## Verificación

La plataforma publica el promedio de cada periodo. El pipeline además lo
recalcula con el modelo que detectó y compara. Si no coinciden, la detección
falló y emite `MODEL_MISMATCH`.

Esto importa porque el peso de un bloque solo existe como texto dentro del
nombre (`"Prueba de Unidad (70%)"`); no hay campo numérico. Si alguien renombra
el bloque, la detección degradaría en silencio. Usa `--strict` en automatizaciones.

| Aviso                   | Sev.  |                                                            |
| ----------------------- | ----- | ---------------------------------------------------------- |
| `MODEL_MISMATCH`        | error | El modelo detectado no reproduce lo publicado. No confiar. |
| `DISTORTION_CORRECTED`  | warn  | Bloque con peso sin notas; promedio renormalizado.         |
| `AGGREGATOR_INCOMPLETE` | warn  | El markbook agregador no cubre todas las asignaturas.      |
| `NO_PUBLISHED_AVERAGE`  | info  | Periodo en curso; promedio estimado.                       |
| `QUALITATIVE_SUBJECT`   | info  | Escala conceptual; fuera del promedio general.             |

Códigos de salida: `0` ok · `1` errores con `--strict` · `2` parámetros ·
`3` credenciales rotas o ausentes (hace falta bootstrap, **no reintentar**) ·
`4` inesperado · `5` estado de la cadena indeterminado (**no reintentar**).

## Estructura

```
package.json        scripts: boletin, test, typecheck, check, build:skill
tsconfig.json
tsconfig.build.json compila src/ a JS plano dentro del skill
.claude/skills/
  isams-boletin/      skill de Claude Code: cómo usar el CLI. El CLI compilado
                      vive en cli/, fuera de git. Ver "Skill de Claude Code".
docs/               referencia de la API y anexos
scripts/
  build-skill.mjs     compila src/ dentro del skill y verifica la deriva
src/
  cli.ts              punto de entrada: valida, orquesta, escribe
  auth.ts             valida el token, deriva el tenant, renueva (§2.5)
  store.ts            almacén de credenciales: inline, archivo o endpoint REST
  extract.ts          llamadas a la API; descarta PII acá
  interpret.ts        escala, modelos de cálculo, correcciones, verificación
  types.ts            contratos. Empieza a leer acá.
  render/
    index.ts          registro de formatos
    html.ts md.ts csv.ts
    styles.css
  profiles/
    britishroyal.ts   escala, etiquetas y textos de un colegio
test/
  run.ts              corre todo: npm test
  store.ts            los tres backends de credenciales
  refresh.ts          rotación y orden de persistencia (§2.7)
  fixture.raw.json    209 columnas reales, sin PII
  mockserver.ts       simula la API para probar la ruta de red
  e2e.ts              validación de parámetros y de token
  pipeline.ts         interpretación y renderers
```

Las salidas (`*.html`, `*.csv`, `datos*.json`) están en `.gitignore`: pueden
contener nombres de menores.

## Skill de Claude Code

`.claude/skills/isams-boletin/` es un skill que le enseña a Claude Code a usar
este CLI. Una vez construido lleva el CLI **compilado adentro**, en `cli/`:
corre con `node` a secas, sin `npm install` ni `node_modules`, y sin necesitar
este repositorio. Es posible porque el CLI no tiene dependencias de runtime —
solo `node:fs`, `node:path` y `node:url`.

**`cli/` no está en git**: es un artefacto, y sale de `src/`. Un clone recién
bajado trae el `SKILL.md` pero no el CLI, así que hay que construirlo antes de
usar el skill o de copiar la carpeta a otra parte.

```bash
npm install                 # el hook prepare lo construye solo
npm run build:skill         # a mano, cuando cambies src/
npm run build:skill:check   # falla si la copia embebida quedó vieja
```

Con `npm install --ignore-scripts` el hook no corre: ahí toca `build:skill`.

`build:skill` compila con `tsconfig.build.json`, copia `styles.css` al lado de
`render/html.js` (que lo lee en runtime), marca la carpeta como ESM y deja un
sello en `cli/BUILD.json` con la huella de `src/`. Termina con una prueba de
humo: si el bundle no arranca, el build falla.

**La copia embebida es un artefacto, no una fuente.** Nunca la edites: edita
`src/` y reconstruye. `npm run check` incluye la verificación de deriva, así que
un `src/` tocado sin reconstruir falla ruidosamente.

Las credenciales **no** viven en el skill. `credenciales.json` queda en el
directorio de trabajo, como siempre.

## Extender

**Otro formato:** un archivo en `src/render/` y una línea en `render/index.ts`.
Recibe el `ReportModel` ya interpretado; no calcula nada.

**Otro colegio:** un archivo en `src/profiles/` y una línea en
`profiles/index.ts`. No toques `interpret.ts` ni los renderers.

En el perfil van escala, umbral de conversión centesimal, prefijo del agregador
y las etiquetas de cada modelo de cálculo. **No** van nombres de periodo, bloque
ni asignatura: son cadenas opacas que se descubren en runtime. Codificarlas es
lo que rompe la portabilidad.

Si el colegio nuevo usa un modelo de cálculo desconocido, saldrá como
`MODEL_MISMATCH` en todos sus periodos: falla ruidosa, no un número inventado.

## Alcance

Verificado sobre un colegio, un año, dos estudiantes, 209 columnas. La
estructura de la API se asume portable; la interpretación del perfil, no.

Sin verificar: comportamiento con `absent: true` (0/209 en la muestra),
paginación en volúmenes altos, y si los seis campos siempre vacíos se pueblan en
otra instalación.

`assessmentDate` viene `null` en 209/209 (dos barridos): **la API no expone
cuándo se rindió cada evaluación.** Para ver evolución en el tiempo hay que
guardar `--save-raw` o `--model` de cada corrida y compararlos.
