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
```

| Opción                   |                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `--format <f>`           | `html`, `md` o `csv`. **Requerido.**                                                                         |
| `[salida]`               | Archivo de salida. Si se omite, escribe a stdout.                                                            |
| `--output <archivo>`     | Archivo de salida. También se acepta como posicional.                                                        |
| `--token <jwt>`          | Access token suelto. Mejor `ISAMS_TOKEN`: en `--token` queda en el historial del shell y es visible en `ps`. |
| `--refresh-token <jwt>`  | Habilita la renovación. Variable: `ISAMS_REFRESH_TOKEN`.                                                     |
| `--token-file <ruta>`    | Credenciales en JSON, reescrito en cada renovación.                                                          |
| `--token-endpoint <url>` | Almacén REST. Ver "Credenciales".                                                                            |
| `--token-api-key <k>`    | Clave del endpoint. Variable: `ISAMS_TOKEN_API_KEY`.                                                         |
| `--token-header <n>`     | Cabecera de la clave. Por defecto `Authorization`.                                                           |
| `--tenant <id>`          | Solo si tienes únicamente el refresh token, que es opaco.                                                    |
| `--no-refresh`           | No renovar aunque haya refresh token.                                                                        |
| `--parents-path <lista>` | Lista opaca del apoderado. Por defecto `1,9,8,4,7,6`.                                                        |
| `--profile <id>`         | Perfil de interpretación. Por defecto, según el tenant del token.                                            |
| `--year <n>`             | Año académico para el título.                                                                                |
| `--save-raw <archivo>`   | Guarda la extracción cruda.                                                                                  |
| `--from-raw <archivo>`   | Lee de un archivo guardado en vez de llamar a la API. No necesita token.                                     |
| `--model <archivo>`      | Guarda además el `ReportModel` en JSON.                                                                      |
| `--delay <ms>`           | Pausa entre llamadas. `0` por defecto: no se observaron cabeceras de rate limit.                             |
| `--strict`               | Sale con código 1 si hay avisos de severidad `error`.                                                        |
| `--quiet`                | Sin mensajes de progreso.                                                                                    |

El progreso y los avisos van a **stderr**; el informe a stdout. Se puede pipear.

## Credenciales

Hay **dos** tokens y hacen cosas distintas:

|                 | Dura        | Para qué                                              |
| --------------- | ----------- | ----------------------------------------------------- |
| `access_token`  | 1 hora      | Consultar la API de datos.                            |
| `refresh_token` | indefinido* | Obtener access tokens nuevos sin volver al navegador. |

\* No verificado. Es lo que permite operar desatendido.

### Bootstrap: sacar ambos del navegador

Se hace **una sola vez**. Abre una ventana **de incógnito** —si el portal queda
abierto en tu sesión normal, su renovación automática compite por la misma
cadena y te deja el token inválido de forma intermitente—, entra al portal y
ejecuta en la consola:

```js
copy(
  JSON.stringify(
    (o => ({ accessToken: o.access_token, refreshToken: o.refresh_token, tenant: location.hostname.split(".")[0] }))(
      JSON.parse(sessionStorage[Object.keys(sessionStorage).find(k => k.startsWith("oidc.user"))])
    ),
    null,
    2
  )
)
```

Pega el resultado en `credenciales.json`. Después **cierra la ventana sin hacer
logout**: el logout llama a `/connect/endsession` y con alta probabilidad revoca
la cadena, inutilizando lo que acabas de copiar.

```bash
npm run boletin -- --format html --token-file credenciales.json notas.html
```

Si el access token está vencido, se renueva solo y el archivo se reescribe.

### Rotación

Cada renovación devuelve un refresh token nuevo e **invalida el anterior**. De
ahí salen tres consecuencias que no son opcionales:

1. El almacén tiene que ser **escribible**. Un refresh token en una variable de
   entorno fija o en un secreto de solo lectura funciona una vez y después falla.
2. El token nuevo se persiste **antes** de tocar la API de datos. Si el proceso
   muere entremedio, la cadena se rompe.
3. `invalid_grant` es **terminal**, no transitorio. No reintentar: rehacer el
   bootstrap.
4. Una sola cadena, un solo consumidor. No dejes el portal abierto mientras corre.

### Token en un endpoint REST

Para no guardar credenciales en disco, el almacén puede ser un servicio propio:
`GET` para leer, `POST` para guardar el rotado.

```bash
npm run boletin -- --format html \
  --token-endpoint https://mi-servicio/tokens/isams \
  --token-api-key "$MI_API_KEY" \
  --output notas.html
```

Cuerpo JSON esperado:

```json
{ "accessToken": "eyJ…", "refreshToken": "…", "expiresAt": "2026-08-19T20:52:08Z", "tenant": "britishroyal" }
```

Al leer también se aceptan `access_token` / `refresh_token` y un envoltorio
`{ "data": { … } }`. La clave va en `Authorization: Bearer <clave>`; con
`--token-header X-API-Key` se envía cruda en la cabecera que indiques.

**El endpoint debe aceptar el POST.** Si falla al guardar, el token viejo ya fue
invalidado por el servidor de identidad y la cadena queda rota.

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
`3` token o API · `4` inesperado.

## Estructura

```
package.json        scripts: boletin, test, typecheck, check
tsconfig.json
docs/               referencia de la API y anexos
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
