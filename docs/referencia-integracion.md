# iSAMS Parent Cloud Portal API — Referencia de integración

Referencia técnica de la API REST que respalda el portal de apoderados de iSAMS
Cloud. Describe cómo autenticarse, renovar credenciales de forma autónoma y
extraer la información académica de todos los estudiantes asociados a una cuenta
de apoderado.

**Ámbito.** Este documento cubre la API tal como la consume el portal oficial.
Es **agnóstico del colegio (tenant)**: todos los valores propios de una
instalación aparecen como parámetros (`{tenant}`, `{schoolId}`, etc.). La
interpretación de las calificaciones —escala de notas y fórmulas de promedio— es
específica de cada colegio y se documenta por separado en el
**sección 10 (Interpretación de calificaciones)**.

**No es documentación oficial de iSAMS.** Fue reconstruida por observación del
tráfico del portal y validada empíricamente (ver Anexo B). Puede cambiar sin
aviso si el proveedor actualiza la plataforma.

**Premisa de autonomía.** El objetivo de diseño es que, partiendo de **un único
par `access_token` + `refresh_token`** obtenido una vez desde el navegador, un
integrador pueda operar de forma desatendida por tiempo indefinido, renovando sus
propias credenciales. Las condiciones para que eso se sostenga están en §2.7–2.9.

---

## Convenciones de notación

| Símbolo | Significado |
|---|---|
| `{tenant}` | Subdominio del colegio, p. ej. `britishroyal` |
| `{schoolId}` | Identificador del estudiante en el colegio (§4.1) |
| `{markbookId}` | Identificador de un libro de notas (§4.2) |
| `{parentsPath}` | Lista opaca separada por comas que identifica la vista del apoderado (§4.1) |
| `{...}` | Cualquier otro valor a sustituir por el integrador |

Nivel de evidencia de cada afirmación:

| Marca | Significado |
|---|---|
| ✅ | Verificado en respuestas reales del servidor |
| ⚠️ | Inferido con evidencia sólida, no probado directamente |
| ❓ | No verificado (ver §9) |

---

## 1. Arquitectura

| Componente | Host | Rol |
|---|---|---|
| API REST de datos | `{tenant}.isams.cloud` | ✅ Endpoints académicos |
| SPA del portal | `{tenant}.parents.isams.cloud` | ✅ Frontend; sede de la sesión OIDC |
| Servidor de identidad | `{tenant}.isams.cloud/auth` | ✅ Authority / issuer OpenID Connect |

**URL base de la API:** `https://{tenant}.isams.cloud/api/portals`

> ⚠️ **Asimetría de hosts.** La SPA se sirve desde `{tenant}.parents.isams.cloud`,
> pero la API y el servidor de identidad viven en `{tenant}.isams.cloud`. Todo el
> tráfico programático (autenticación y datos) apunta a este último.

**Infraestructura observada:** ✅ el servicio está tras Cloudflare
(`server: cloudflare`). Cada respuesta incluye `x-request-tag` (UUID de la
petición, útil para soporte) y `x-user` (código del usuario autenticado). La
cabecera `api-supported-versions: 1.0` sugiere versionado; no se observó
mecanismo para solicitar una versión distinta. ❓

---

## 2. Autenticación (OpenID Connect)

El portal usa OIDC con **cliente público** (sin secreto) y **PKCE** para el login
inicial, y **refresh tokens rotativos** para la operación continua.

### 2.1 Descubrimiento

Todos los endpoints del servidor de identidad se obtienen de:

```
GET https://{tenant}.isams.cloud/auth/.well-known/openid-configuration
```

Documento público, sin credenciales. **Es la fuente de verdad**; ante cualquier
divergencia con esta referencia, prevalece el documento de descubrimiento.

### 2.2 Endpoints del servidor de identidad ✅

| Endpoint | Ruta | Uso en integración |
|---|---|---|
| Authorization | `/auth/connect/authorize` | Login inicial (navegador, una sola vez) |
| **Token** | `/auth/connect/token` | ⭐ Renovación autónoma de credenciales |
| Revocation | `/auth/connect/revocation` | 🔒 Revocar un token comprometido |
| End session | `/auth/connect/endsession` | ⚠️ Logout — ver §2.9 |
| UserInfo | `/auth/connect/userinfo` | No requerido |
| Check session | `/auth/connect/checksession` | iframe interno de la SPA |
| Introspection | `/auth/connect/introspect` | No requerido |

### 2.3 Parámetros del cliente ✅

| Parámetro | Valor | Origen |
|---|---|---|
| `client_id` | `iSAMS.Portal.Cloud.Parents` | Fijo para el portal de apoderados |
| Tipo de cliente | Público (sin `client_secret`) | Confirmado: ninguna llamada envía secreto |
| `scope` | `openid offline_access iSAMS.CloudPortals.Api iSAMS.Auth.ChangeAccountPassword.Invoke` | Debe reenviarse íntegro en cada refresh |

> ⚠️ El `client_id` `iSAMS.Portal.Cloud.Parents` corresponde al producto "portal
> de apoderados" de iSAMS y es razonable esperar que sea **común a todos los
> tenants**, pero solo se verificó en uno. ❓ Confirmarlo con §2.1 en otra
> instalación.

> ❗ **`offline_access` es el scope que habilita los refresh tokens.** Sin él no
> hay operación autónoma posible.

### 2.4 Obtención inicial de credenciales (bootstrap)

El login interactivo (Authorization Code + PKCE) ocurre **una sola vez, en el
navegador**. El integrador no lo automatiza; extrae el resultado.

Tras autenticarse en `{tenant}.parents.isams.cloud`, la SPA guarda la sesión OIDC
completa en **`sessionStorage`** (no `localStorage`), del origen del portal, bajo
la clave: ✅

```
oidc.user:https://{tenant}.isams.cloud/auth:iSAMS.Portal.Cloud.Parents
```

El valor es un JSON con, entre otros campos: `access_token`, `refresh_token`,
`expires_at`, `token_type`, `scope`, `id_token`, `profile`. ✅

**Procedimiento de bootstrap** (una vez): iniciar sesión en el portal, leer esa
clave del `sessionStorage`, y copiar `access_token` y `refresh_token`. Desde ese
punto, la operación es autónoma vía §2.5.

> ⚠️ `sessionStorage` se borra al cerrar la pestaña; la extracción debe hacerse
> con la sesión abierta. Ver §2.9 para las condiciones que preservan la validez
> del token extraído.

### 2.5 Renovación de credenciales ✅

Es la operación central de la autonomía. Intercambia un `refresh_token` por un
`access_token` nuevo (y un `refresh_token` nuevo).

```http
POST https://{tenant}.isams.cloud/auth/connect/token
Content-Type: application/x-www-form-urlencoded
```

*(sin cabecera `Authorization`)*

**Cuerpo — cuatro campos exactos:** ✅

```
grant_type=refresh_token
&refresh_token={REFRESH_TOKEN}
&scope=openid offline_access iSAMS.CloudPortals.Api iSAMS.Auth.ChangeAccountPassword.Invoke
&client_id=iSAMS.Portal.Cloud.Parents
```

> ❗ **`scope` es obligatorio y debe repetir el scope original completo.**
> Omitirlo puede degradar el scope o hacer fallar la petición.
> **No enviar `client_secret`:** el cliente es público y hacerlo puede provocar
> rechazo.

**Respuesta — 200 OK:** ✅

```json
{
  "id_token": "{ID_TOKEN}",
  "access_token": "{ACCESS_TOKEN}",
  "expires_in": 3600,
  "token_type": "Bearer",
  "refresh_token": "{NUEVO_REFRESH_TOKEN}",
  "scope": "openid offline_access iSAMS.CloudPortals.Api iSAMS.Auth.ChangeAccountPassword.Invoke"
}
```

`expires_in` observado: **3600 s** (1 hora). ✅

### 2.6 Uso del access token contra la API de datos ✅

```http
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json
```

**No hay cookies ni CSRF.** La cabecera `Authorization` es suficiente. ✅
La cabecera `Referer` **no es obligatoria** (verificado: una petición sin ella
responde `200`). ✅

El access token es un JWT `RS256` de tipo `at+jwt`, con audiencia
`["REST API", "Authentication Server"]`; la audiencia `REST API` es la que
habilita la API de datos. Su vida útil es de 1 hora (`exp − iat = 3600`). ✅ No es
necesario inspeccionar sus claims para operar, pero `expires_at` (del objeto de
sesión) permite renovar de forma anticipada en lugar de reactiva.

### 2.7 ❗ Rotación de refresh tokens

**Cada renovación devuelve un `refresh_token` nuevo e invalida el anterior.** ✅
Esto es obligatorio para la autonomía y define tres requisitos:

1. **Persistir el nuevo `refresh_token` en cada respuesta, de forma atómica y
   antes de cualquier otra operación.** Si el proceso termina entre la renovación
   y la escritura, la cadena se rompe y hace falta un nuevo bootstrap (§2.4).
2. **El almacén de credenciales debe ser escribible**, no solo legible. Inyectar
   el refresh token como valor inmutable (variable de entorno fija, secreto de
   solo lectura) sin un canal de reescritura **no funciona** con rotación.
3. Un `refresh_token` ya usado **falla de forma permanente** (§7). No es un error
   transitorio: no reintentar, re-bootstrapear.

### 2.8 ❗ Renovación anticipada y ventana de solapamiento

Como el access token dura 1 hora, un proceso que corre con menos frecuencia debe
renovar al inicio de cada ejecución. Se recomienda renovar cuando reste poco para
`expires_at` **o siempre al arrancar**, y usar el `access_token` resultante para
toda la corrida.

⚠️ No emitir dos renovaciones concurrentes sobre la misma cadena: por la rotación
(§2.7), la segunda invalidaría a la primera. Serializar las renovaciones.

### 2.9 ❗ Exclusividad de la cadena de refresh

Consecuencia de la rotación que provoca fallos intermitentes si se ignora. ⚠️

**Una cadena de refresh admite un solo consumidor.** Si el navegador mantiene la
sesión abierta, su *silent renew* rota el token y deja inválido el que tiene el
integrador (y viceversa). Síntoma: `invalid_grant` esporádico sin patrón.

Para garantizar exclusividad en el bootstrap (§2.4):

1. Iniciar sesión en una **ventana de incógnito** dedicada.
2. Extraer el `refresh_token`.
3. **Cerrar la ventana sin hacer logout.** El logout invoca `/connect/endsession`
   y, con alta probabilidad, revoca la cadena — inutilizando el token extraído. ⚠️
4. No volver a iniciar sesión con esa cuenta en paralelo mientras el integrador
   opere, o se competirá por la cadena.

---

## 3. Modelo de recursos

La API expone tres recursos anidados. La relación es un árbol:

```
apoderado ──1:N── estudiante ──1:N── markbook ──1:N── column
 {parentsPath}     {schoolId}        {markbookId}      (evaluación o cálculo)
```

- **Estudiante** — cada hijo asociado al apoderado.
- **Markbook** — un libro de notas. Normalmente una asignatura; uno especial por
  estudiante **agrega** los promedios de todas sus asignaturas (§4.4).
- **Column** — una fila del libro: o bien una evaluación con nota
  (`type: "Assessment"`), o bien un valor derivado/promedio
  (`type: "Calculation"`).

Todos los endpoints son `GET`, devuelven JSON, y **no presentan paginación** en
los volúmenes observados (hasta ~30 columnas por markbook). ✅

---

## 4. Endpoints de datos

### 4.1 Listar estudiantes del apoderado

```
GET /api/portals/students/portal/parents/{parentsPath}
```

Devuelve los estudiantes asociados a la cuenta.

**`{parentsPath}`** es una lista de enteros separada por comas (p. ej.
`1,9,8,4,7,6`). ❓ **Es un valor opaco**: no se deriva de ningún claim del token y
debe obtenerse observando la petición que hace el portal (Network tab) durante el
bootstrap. ⚠️ Tratarlo como una credenciales de configuración más, junto al
refresh token.

**Respuesta** — objeto con un array `students`. Cada elemento tiene **~59
campos**; la extracción académica requiere solo unos pocos:

| Campo | Tipo | Uso |
|---|---|---|
| `schoolId` | string | ✅ **Clave** para §4.2 y §4.3 |
| `id` | int | Identificador interno. ⚠️ **NO sirve** en §4.2/§4.3 — no confundir |
| `fullName` / `preferredName` | string | Presentación |
| `formGroup` | string | Curso/sección (etiqueta opaca) |
| `yearGroup` | int | Nivel. Útil para agrupar; **no** determina el modelo de cálculo (§10) |
| `schoolCode` | string | Código institucional |
| `familyId` | int | Compartido entre hermanos |

> ⚠️ **`id` ≠ `schoolId`.** Los endpoints de markbooks aceptan **solo**
> `schoolId`. Es el error de integración más fácil de cometer.

> 🔒 **Los ~53 campos restantes son datos personales sensibles** (domicilio,
> fecha de nacimiento, correo escolar, nacionalidad, religión, etnia,
> discapacidades, foto). Ver el documento de anexos (inventario de datos personales). Un consumidor debe **descartarlos en la
> normalización**, no persistirlos.

### 4.2 Listar markbooks de un estudiante

```
GET /api/portals/markbooks/students/{schoolId}
```

**Respuesta** — array plano de markbooks:

```json
[
  { "id": 1146, "description": null, "name": "{curso} {asignatura} {año}", "publishedColumns": null }
]
```

| Campo | Tipo | Nota |
|---|---|---|
| `id` | int | ✅ `{markbookId}` para §4.3 |
| `name` | string | Etiqueta legible. **No parsear** para extraer curso/asignatura de forma fiable (ver abajo) |
| `description` | string \| null | `null` en asignaturas; **poblado solo en el markbook agregador** (§4.4) |
| `publishedColumns` | — | `null` en todo lo observado. Propósito desconocido ❓ |

> ❗ **Los `id` no son predecibles.** No siguen un patrón extrapolable
> (espaciados de 4 o 5 con excepciones). **Enumerar siempre** vía este endpoint;
> nunca generar IDs por aritmética. ✅

> ⚠️ **`name` no es fuente confiable de metadatos.** Se observó: prefijo de curso
> ausente cuando la asignatura agrupa por nivel cruzando secciones; tildes
> inconsistentes entre estudiantes; espacios faltantes. Usar `name` para
> mostrar, no para lógica. El curso real está en `formGroup` del estudiante.

### 4.3 Listar columnas de un markbook

```
GET /api/portals/markbooks/{markbookId}/students/{schoolId}/columns
```

**Respuesta** — array plano de columnas. Es el recurso central de la API.

```json
{
  "id": 33654,
  "name": "Ev. 1",
  "type": "Assessment",
  "value": "33",
  "outOf": null,
  "parentGroupings": [
    { "id": 3655, "name": "Semestre 1", "gradingPeriodId": null, "publishedName": null },
    { "id": 3656, "name": "Evaluaciones de Proceso 30%", "gradingPeriodId": null, "publishedName": null }
  ],
  "absent": false,
  "submitted": true,
  "hasComments": false,
  "assessmentDate": null,
  "weightedValue": null,
  "transposeValues": [],
  "clientTypeId": null,
  "historicAspectId": null,
  "isGradingPeriodCalculation": false,
  "isYearAverageCalculation": false
}
```

#### Diccionario de campos ✅

| Campo | Tipo | Semántica |
|---|---|---|
| `id` | int | Identificador único de la columna |
| `name` | string | Etiqueta de la evaluación o del cálculo. **Opaca** — ver §5 |
| `type` | enum | `"Assessment"` (nota registrada) \| `"Calculation"` (valor derivado). Ver §4.3.1 |
| `value` | string \| null | Contenido de la celda. Formato **variable** — ver §10. `null` = sin dato |
| `outOf` | number \| null | Denominador de la nota, si aplica. `null` en todo lo observado |
| `parentGroupings` | array | Jerarquía de la columna (§4.3.2) |
| `absent` | bool | Marca de inasistencia en esa evaluación |
| `submitted` | bool \| null | ✅ `true` ⟺ `type=="Assessment"`; `null` ⟺ `type=="Calculation"` (§4.3.1) |
| `hasComments` | bool | Existe comentario del profesor (endpoint de lectura desconocido ❓) |
| `assessmentDate` | string \| null | Fecha de la evaluación |
| `weightedValue` | — \| null | Valor ponderado precalculado. Vacío en todo lo observado |
| `transposeValues` | array | Vacío en todo lo observado |
| `clientTypeId` | — \| null | Vacío en todo lo observado |
| `historicAspectId` | — \| null | Vacío en todo lo observado |
| `isGradingPeriodCalculation` | bool | ⚠️ **`false` incluso en promedios de periodo** — no usar |
| `isYearAverageCalculation` | bool | ⚠️ **`false` incluso en promedios anuales** — no usar |

> ⚠️ **`isGradingPeriodCalculation` e `isYearAverageCalculation` son
> inservibles** para identificar agregados: `false` en el 100% de las columnas.
> Para distinguir una nota de un cálculo, usar **`type`** (equivalente:
> `submitted`).

> ⚠️ **Seis campos vienen vacíos en el 100% de lo observado** (`outOf`,
> `weightedValue`, `assessmentDate`, `transposeValues`, `clientTypeId`,
> `historicAspectId`). Un consumidor robusto **debe manejarlos defensivamente**
> por si otra instalación los pobla, pero no puede depender de ellos. ❓

#### 4.3.1 `Assessment` vs `Calculation`

Regla verificada (n=209, coincidencia exacta): ✅

- `type == "Assessment"` ⟺ `submitted == true` → **nota registrada por un
  profesor**.
- `type == "Calculation"` ⟺ `submitted == null` → **valor derivado** (promedio,
  agregado) calculado por la plataforma.

Ambos usan el mismo campo `value`, pero **su formato puede diferir** — ver §10.

#### 4.3.2 `parentGroupings` — jerarquía de la columna

Array **ordenado de lo general a lo específico** que ubica la columna en la
estructura del libro. Su **profundidad varía de 0 a 3**. ✅

| Profundidad | Significado típico | Ejemplo (`[names...]`) |
|---|---|---|
| 0 | Agregado global del libro | `[]` (p. ej. un promedio final de asignatura) |
| 1 | Agregado de un periodo | `["Semestre 1"]` |
| 2 | Evaluación dentro de un bloque, **o** promedio por asignatura en el agregador | `["Semestre 1", "Evaluaciones de Proceso 30%"]` |
| 3 | Nivel extra (observado en el agregador, para idiomas) | `["PROMEDIOS 2026", "Idioma Extranjero Inglés", "L4"]` |

En un markbook de asignatura, la convención observada es:
`[0]` = periodo, `[1]` = bloque de evaluación.

> ❗ **La profundidad no es constante ni siquiera dentro de un mismo libro.** Un
> agregado de periodo puede traer `parentGroupings: []` en lugar de
> `["Semestre 2"]`. **No se puede determinar el periodo de un agregado desde
> `parentGroupings`;** hay que leerlo del `name` (§5). ✅

> ⚠️ **Los `id` de grouping no son globales.** El mismo bloque lógico tiene un
> `id` distinto en cada periodo. **Agrupar por `name`, nunca por `id`** (salvo
> dentro de un mismo periodo ya acotado). ✅

### 4.4 El markbook agregador

Cada estudiante tiene **un markbook adicional que consolida los promedios de
todas sus asignaturas**. ✅ Es la vía más eficiente para un resumen: **una
petición** en lugar de una por asignatura.

**Identificación robusta:** ✅ es el único markbook cuyo `description` **no es
nulo ni vacío** y **empieza con** `"Promedios de Asignaturas"`.

> ❗ **Coincidencia por prefijo, no exacta.** Se observó `"Promedios de
> Asignaturas"` y `"Promedios de Asignaturas SENIOR"`. Además, `description`
> puede venir como `null` **o como cadena vacía** en los demás markbooks: tratar
> ambos como "sin descripción".

**Estructura distintiva:** en el agregador, `parentGroupings[1]` es el **nombre
de la asignatura**, no un bloque de evaluación:

```
Calculation | "Promedio Asignatura Semestre 1" | ["PROMEDIOS...", "Matemática"]
Calculation | "Promedio Final Asignatura"      | ["PROMEDIOS...", "Matemática"]
Calculation | "Promedio Final 1S"              | []   (global del estudiante)
Calculation | "Promedio General"               | []   (anual del estudiante)
```

Contiene tres niveles de agregación: por asignatura-periodo, por semestre del
estudiante completo (`Promedio Final 1S/2S`), y anual global (`Promedio
General`). ✅ Los nombres de estas columnas **no están estandarizados** entre
asignaturas — ver §5.

---

## 5. Regla de oro: las cadenas de texto son opacas

Varios campos contienen texto legible que **es tentador parsear**, pero cuya
forma varía entre asignaturas, niveles, colegios y años. Tratarlos como opacos
es lo que hace que una integración sea portable.

| Campo | Varía porque… | Regla |
|---|---|---|
| `parentGroupings[i].name` (periodo) | Puede ser `"Semestre 1"`, `"PROMEDIOS 2026"`, etc. | No asumir `"Semestre "+N`. Usar como etiqueta/clave de agrupación |
| `parentGroupings[i].name` (bloque) | El peso puede estar embebido (`"...30%"`) o no | La *presencia* de peso define el modelo de cálculo (§10), pero el nombre en sí es una etiqueta |
| `column.name` (promedio) | 13+ variantes observadas: `"Promedio Semestral 1"`, `"Promedio Asignatura Semestre 1"`, `"Promedio Final"`, `"Promedio General"`, `"Nota Parcial 1 (Ev. Procesos)"`… | Si se debe clasificar, usar coincidencias **tolerantes** (contiene/empieza-con), nunca igualdad exacta |
| `markbook.name` | Prefijos, tildes y espacios inconsistentes | Solo para mostrar. Metadatos reales en campos estructurados |
| `markbook.description` | `"Promedios de Asignaturas"` con sufijos | Coincidencia por **prefijo** (§4.4) |

> Corolario: **no codificar en duro** ningún nombre de periodo, bloque,
> asignatura ni columna de promedio. Descubrirlos en runtime desde las
> respuestas.

---

## 6. Flujo de extracción de referencia

```
0. RENOVAR CREDENCIALES (§2.5)
   POST /auth/connect/token  (grant_type=refresh_token)
   → access_token + NUEVO refresh_token
   → PERSISTIR el refresh_token nuevo, atómicamente (§2.7)

1. LISTAR ESTUDIANTES (§4.1)
   GET /students/portal/parents/{parentsPath}
   → por cada estudiante: schoolId  (descartar PII — ver documento de anexos)

2. LISTAR MARKBOOKS (§4.2)   [por schoolId]
   GET /markbooks/students/{schoolId}
   → separar el agregador (§4.4) de las asignaturas

3. LISTAR COLUMNAS (§4.3)    [por markbookId + schoolId]
   GET /markbooks/{markbookId}/students/{schoolId}/columns
   → normalizar a un modelo plano (§6.1)

4. INTERPRETAR (§10)     [opcional, específico del colegio]
   → escala de value, promedios, correcciones
```

**Volumen medido:** 2 estudiantes con 11 y 12 asignaturas = 26 peticiones, 209
columnas, ~15 s con 300 ms de intervalo entre llamadas. ✅

**Atajo de resumen:** para solo promedios, basta el agregador (§4.4) — 1 petición
de columnas por estudiante en lugar de N. El detalle por evaluación sí requiere
recorrer cada asignatura.

**Límites de tasa:** no se observaron cabeceras `X-RateLimit-*` ni `Retry-After`.
❓ Su ausencia no garantiza que no exista throttling; mantener un intervalo entre
llamadas y una cadencia moderada.

### 6.1 Modelo normalizado sugerido

Una fila por columna, con las cadenas opacas preservadas tal cual:

```
estudiante · schoolId · yearGroup · markbookId · markbookName · esAgregador
          · groupings[] (nombres, en orden) · columnName · type · value
          · outOf · absent · hasComments
```

Toda interpretación (escala, periodo, bloque, peso, promedio) se deriva de esta
tabla aplicando la §10. Mantener la capa de extracción **libre de reglas de
negocio** permite reusarla en otro colegio cambiando solo el anexo.

---

## 7. Modos de falla

| Situación | Respuesta | Acción |
|---|---|---|
| Access token vencido | `401` | Renovar (§2.5) y reintentar. Vida útil 1 h |
| Refresh token usado/rotado/revocado | `400 invalid_grant` | ❗ Cadena rota. **No reintentar** — re-bootstrap (§2.4) |
| `scope` omitido en el refresh | ❓ Rechazo o downgrade | Reenviar el scope completo (§2.3) |
| `client_secret` enviado | ❓ Probable rechazo | El cliente es público — no enviarlo |
| `id` usado como `schoolId` | Error o vacío | Usar `schoolId` (§4.1) |
| Logout del portal durante operación | — | ⚠️ Probable revocación de la cadena (§2.9) |
| Dos renovaciones concurrentes | `invalid_grant` en una | Serializar renovaciones (§2.8) |

**Diseño de alertas.** Distinguir el fallo **reintentable** (red, `401`) del
**terminal** (`invalid_grant`, requiere intervención humana). Notificar el
segundo de forma explícita: de lo contrario la automatización se detiene en
silencio y la falta de datos puede pasar inadvertida.

---

## 8. Seguridad y privacidad

- **El refresh token es la credencial crítica**: da acceso persistente a datos de
  menores. Almacenarlo cifrado y con escritura controlada (§2.7). Nunca en
  endpoints públicos, prompts, repositorios ni logs.
- **Existe endpoint de revocación** (`/auth/connect/revocation`). Ante sospecha de
  filtración, revocar es la contención inmediata.
- **Minimización de datos**: el endpoint de estudiantes devuelve ~59 campos; la
  extracción académica necesita ~6. Descartar el resto **en la normalización**
  (ver documento de anexos). Lo que no se persiste no se filtra.
- **Access tokens en tránsito**: válidos 1 h; no compartirlos en canales
  observables.
- **Cadencia responsable**: intervalo entre llamadas; una API de un colegio no
  está dimensionada para polling intensivo.
- **Alcance legítimo**: usar solo credenciales propias del apoderado sobre datos
  de sus propios hijos, vía los mismos endpoints del portal oficial.

---

## 9. Aspectos no verificados

| Aspecto | Impacto | Cómo verificarlo |
|---|---|---|
| Duración del refresh token | Frecuencia de re-bootstrap | Observación empírica sostenida |
| Si el logout revoca la cadena | Confirma §2.9 | Cerrar sesión y luego intentar un refresh |
| `client_id` común a todos los tenants | Portabilidad de §2.3 | Leer §2.1 en otra instalación |
| Comportamiento real de `absent: true` | Semántica en §10.5 | Esperar una inasistencia registrada |
| Endpoints de comentarios / detalle | `hasComments` sin lector conocido | Abrir esos íconos con Network activo |
| Existencia de throttling | Robustez de la automatización | Elevar cadencia de forma controlada |
| Origen de `{parentsPath}` | Hoy se copia del navegador | Inspeccionar el bootstrap de la SPA |
| Semántica de `api-supported-versions` | Posible versionado | Probar cabecera `Accept` con versión |
| Campos siempre vacíos | Podrían poblarse en otro tenant/año | Repetir el sondeo en otra instalación |
| Endpoints de asistencia/horario/tareas | Alcance funcional futuro | Recorrer el portal con Network activo |
| Paginación en volúmenes altos | Escalabilidad | Observar un markbook con muchas columnas |

> ❗ **Sin `assessmentDate` no hay eje temporal.** El campo vino `null` en el
> 100% de las columnas observadas, en barridos repetidos del mismo tenant. El
> orden de las columnas es el único indicio de secuencia, y no permite fechar una
> evaluación ni medir tendencia. Un consumidor que quiera series de tiempo debe
> **versionar sus propias extracciones** y construir el eje temporal desde la
> fecha de captura.

> ⚠️ La repetición de un barrido sobre el mismo tenant, mismo año y mismos
> estudiantes acredita **estabilidad entre barridos**, no confirmación adicional.
> La fila "Campos siempre vacíos" sigue abierta hasta probar otra instalación.

---

## 10. Interpretación de calificaciones

Las secciones 1–9 describen la API de forma **agnóstica del colegio**. Esta
sección describe cómo **interpretar** el campo `value` y reconstruir promedios
para el tenant `britishroyal` (colegio chileno, escala 1,0–7,0).

> ⚠️ **Esta sección es específica de la configuración de un colegio.** La API
> devuelve las mismas estructuras en cualquier instalación, pero la escala de
> notas, los nombres de bloque y las fórmulas de promedio dependen de cómo cada
> colegio configuró iSAMS. Para otro colegio, se reescribe solo esta sección; las
> secciones 1–9 permanecen válidas.

Base empírica: 209 columnas, 2 estudiantes, 2 niveles (ver documento de anexos).

### 10.1 Escala del campo `value`

En este tenant, `value` codifica la **escala chilena 1,0–7,0** (aprobación 4,0),
pero con **dos representaciones distintas** en el mismo campo: ✅

| Caso | Formato | Ejemplo | Interpretación |
|---|---|---|---|
| Nota "en centésimas" | Entero, string | `"51"` | 5,1 |
| Nota "en escala" | Decimal, string | `"3.8"` | 3,8 |
| Sin dato | `null` | — | evaluación no rendida / no ingresada |
| Cualitativa | No numérico | `"MB"` | ver 10.2 |

El `type` **no** discrimina la representación: se observaron `Calculation` en
ambos formatos (`"70"` = 7,0 y `"7"` = 7,0 en un mismo markbook). ✅

**Regla de conversión verificada** — se apoya en el rango de la escala, no en el
tipo ni en la presencia de punto decimal:

```
si value es null o ""            → sin nota
si value no es numérico          → nota cualitativa (§10.2)
si Number(value) > 7             → Number(value) / 10       // estaba en centésimas
en otro caso  (0 < v ≤ 7)        → Number(value)            // ya en escala
```

**Por qué el umbral 7 es seguro:** una nota válida está en [1,0 ; 7,0]. Un valor
> 7 solo puede ser la representación en centésimas (≥ 10). No hay solapamiento,
así que la regla es determinista. ✅ Validada sobre las 191 columnas numéricas:
**0 resultados fuera de [1,0 ; 7,0]**.

---

### 10.2 Notas cualitativas

Algunas asignaturas usan una **escala conceptual** en lugar de numérica. Se
observó el valor `"MB"` (presumiblemente *Muy Bueno*) en la asignatura
"Filosofía de las Emociones". ✅

Consecuencias:

- `Number("MB")` es `NaN`. Convertir sin validar **propaga `NaN`** a cualquier
  promedio que incluya esa asignatura. Validar que `value` sea numérico **antes**
  de convertir.
- Las asignaturas cualitativas **no deben mezclarse** en promedios numéricos.
  Tratarlas como una dimensión aparte.

> ❓ Solo se observó `"MB"`. La escala completa (¿`B`, `S`, `I`? ¿otro orden?) y
> su ordenamiento **no están confirmados**. No asumir un conjunto cerrado de
> valores.

---

### 10.3 Modelos de cálculo de promedios

Este colegio usa **tres modelos distintos**, y **coexisten dentro de un mismo
nivel** — no se puede predecir el modelo por `yearGroup`. ✅ El modelo se
**infiere de la forma de los bloques** del periodo, no de ningún campo declarado
(no existe tal campo).

> **Nomenclatura.** Los nombres `ponderado`, `cascada` y `plano` son de esta
> referencia; la API no los expone. Para interfaces dirigidas a apoderados
> conviene una etiqueta que describa el procedimiento y no la estructura:
>
> | Nombre técnico | Etiqueta de lectura | Qué hace |
> |---|---|---|
> | `plano` (10.3.3) | promedio simple | Media de todas las notas del periodo |
> | `ponderado` (10.3.1) | con porcentajes | Cada bloque aporta según su peso |
> | `cascada` (10.3.2) | en dos pasos | Un bloque se resume en una nota que entra al otro |

#### 10.3.1 Modelo ponderado

Los bloques llevan el **peso embebido en el nombre**:

```
"Evaluaciones de Proceso 30%"  → 0,30
"Prueba de Unidad (70%)"       → 0,70
```

Peso extraíble con `/(\d{1,3})\s*%/`. Cálculo:

```
promedio_periodo = Σ (promedio_del_bloque × peso_del_bloque)
```

Un bloque puede tener **varias** evaluaciones que se promedian entre sí antes de
ponderar (en un caso, el bloque del 70% contenía tres pruebas). ✅

#### 10.3.2 Modelo en cascada

**Sin pesos.** Los bloques (p. ej. `"Evaluaciones de Proceso (NP1)"` y
`"Notas Parciales S1"`) no contienen porcentaje. El promedio del periodo es la
**media simple de todas las filas del bloque terminal** — y ese bloque **mezcla
`Assessment` y `Calculation`**: ✅

- El promedio del bloque de proceso se materializa como una fila `Calculation`
  ("Nota Parcial 1 (Ev. Procesos)") **dentro** del bloque terminal.
- El promedio del periodo promedia todas las filas con valor de ese bloque,
  **incluida** esa fila `Calculation`.

> ❗ Promediar solo las `Assessment` da un resultado incorrecto (en un caso, 5,26
> en vez de 5,5). Al promediar el bloque terminal, incluir **todas** las filas
> con valor, sin filtrar por `type`. ✅

**Peso relativo.** Como las evaluaciones de proceso se comprimen en **una sola
fila** del bloque terminal, todas ellas **se reparten entre sí el espacio de una
nota parcial**. Con `p` evaluaciones de proceso y `t` filas con valor en el
bloque terminal, cada parcial aporta `1/t` y cada evaluación de proceso
`1/(p·t)`.

Ejemplo (Biología, Semestre 1): 2 evaluaciones de proceso, bloque terminal con
3 filas con valor. Cada parcial pesa 1/3; cada evaluación de proceso, 1/6. ✅

A diferencia del modelo ponderado (10.3.1), donde la proporción es **fija** por
definición del bloque, aquí **varía con la cantidad** de evaluaciones de proceso
del periodo.

> ❗ **La numeración de las notas parciales empieza en 2.** El nombre
> `"Nota Parcial 1"` está reservado para el promedio del bloque de proceso, y la
> reserva se respeta **aunque ese bloque no exista**: en 7 de 15 bloques
> observados no había proceso ni fila derivada, y las parciales igual partían en
> `"Nota Parcial 2"`. ✅ Dentro de un bloque de notas parciales,
> `"Nota Parcial 1"` nunca es una nota registrada por un profesor (0
> `Assessment` en 15 bloques). ✅
>
> No hay ninguna nota faltante. **No inferir ausencias desde la numeración** —
> `column.name` es una etiqueta opaca (§5) y su número no es un índice. La
> comprobación correcta es estructural: mirar si el bloque contiene una fila
> `Calculation`, no si la numeración parte en 1.

> ⚠️ **La convención es local al modelo cascada, no global.** En asignaturas
> `plano` sí existen columnas `Assessment` llamadas `"Nota Parcial 1"` (3 casos
> observados), colgando directamente del periodo sin bloque intermedio. La
> numeración desde 2 aplica **solo dentro de un bloque de notas parciales**;
> fuera de ahí, `"Nota Parcial 1"` es una nota común y corriente.

#### 10.3.3 Modelo plano

**Sin bloques.** Las evaluaciones cuelgan directamente del periodo
(`parentGroupings` de profundidad 1). El promedio del periodo es la **media
simple** de esas evaluaciones. ✅

#### 10.3.4 Detección del modelo

```
bloques = grupos distintos de parentGroupings[1].name en el periodo
si no hay bloques                         → PLANO (10.3.3)
si algún bloque tiene % en el nombre      → PONDERADO (10.3.1)
en otro caso                              → CASCADA (10.3.2)
```

Preferir esta detección estructural a condicionar por `yearGroup`. ✅

> ⚠️ **La detección se apoya en una cadena de presentación.** El peso solo existe
> como texto dentro de `parentGroupings[].name`; no hay campo numérico que lo
> declare (`weightedValue` viene vacío en el 100% de lo observado). Renombrar un
> bloque quitándole el `%` reclasifica el periodo a CASCADA **sin error visible**:
> ninguna excepción, ningún valor fuera de rango, solo un promedio distinto.
>
> Verificación sugerida, barata y con buena señal:
>
> ```
> si modelo == CASCADA y hay ≥2 bloques en el periodo:
>     el bloque terminal debería contener ≥1 fila Calculation (§10.3.2)
>     si no la contiene → posible ponderado mal detectado; revisar
> ```
>
> Con un solo bloque la comprobación no aplica (7 de 15 casos observados). ❓ La
> regla se cumple en toda la muestra, pero un solo tenant no basta para darla por
> universal.

#### 10.3.5 Promedio final de la asignatura

En los tres modelos, el promedio final de asignatura es la **media simple de los
promedios de periodo**. ✅ No se pondera por número de evaluaciones ni por
semestre.

---

### 10.4 ❗ La estrategia recomendada: confiar en el valor publicado

Reconstruir los tres modelos es necesario **solo** para un caso. La plataforma ya
publica el promedio correcto en la enorme mayoría de las situaciones; el único
caso en que el valor publicado engaña es la **distorsión por bloque vacío** del
modelo ponderado (10.4.1).

**Algoritmo unificado, independiente del nivel y a prueba de modelos futuros:**

```
para cada (asignatura, periodo):
    pesos = pesos de los bloques con datos (10.3.1)
    si  hay algún peso  Y  Σ pesos < 100%:
        → RECALCULAR: Σ(promedio_bloque × peso) / Σ(pesos)   (renormalizado)
    en otro caso:
        → USAR el valor de la columna de promedio publicada por la plataforma
```

Validación (30 periodos): **28 toman el valor publicado, 2 se recalculan**, 0
omisiones, sin consultar `yearGroup`. ✅

**Por qué es robusto:** si aparece un cuarto modelo en otro nivel o colegio, cae
en la rama "usar el publicado" y entrega el número correcto de la plataforma, en
lugar de aplicar una fórmula que no le corresponde. La lógica de cálculo explícita
(10.3) solo hace falta para **estimar** un promedio que la plataforma aún no ha
publicado.

#### 10.4.1 Distorsión por bloque vacío

**Solo afecta al modelo ponderado.** ✅ Cuando un bloque con peso aún no tiene
notas, la plataforma lo pondera como **0** en lugar de excluirlo, hundiendo el
promedio publicado.

Ejemplo verificado:

| Periodo | Bloques con datos | Cálculo de la plataforma | Publica | Real |
|---|---|---|---|---|
| Con 70% pendiente | 30% → 4,90 ; 70% ausente | `4,90×0,3 + 0×0,7` | **1,5** | **4,9** |

El promedio final hereda la distorsión (media simple con el semestre hundido).

**Los modelos cascada y plano NO sufren esto:** excluyen las filas sin valor en
vez de contarlas como 0. ✅ Verificado: 0 de 15 periodos en cascada distorsionados.

**Detección — dos casos, ambos necesarios:** ⚠️

1. El bloque **existe** como columna pero sin notas.
2. El bloque **no existe aún** como columna (caso frecuente al inicio de un
   periodo): no hay nada que marcar como vacío; se detecta porque **Σ de los
   pesos presentes < 100%**.

**Corrección:** excluir bloques sin datos y **renormalizar** los pesos restantes
para que sumen 1 (es lo que hace el algoritmo de 10.4).

---

### 10.5 Señal de inasistencia

Un promedio anómalo puede deberse a dos causas opuestas: ⚠️

1. **Evaluación aún no rendida** → se corrige sola al ingresarse.
2. **Nota pendiente por inasistencia** → requiere gestión con el colegio.

El campo `absent: true` de la columna es la señal que las distingue. Exponerlo
siempre en cualquier reporte.

> ❓ En las 209 columnas observadas, `absent` fue siempre `false`. Su
> comportamiento con datos reales **no está verificado**; la semántica descrita
> es la esperada según la estructura.

---

### 10.6 Resumen de reglas de interpretación

| # | Regla | Ref. |
|---|---|---|
| 1 | Convertir escala por rango (`v > 7 ⇒ v/10`), no por `type` ni por decimal | 10.1 |
| 2 | Validar que `value` sea numérico antes de convertir | 10.2 |
| 3 | Detectar el modelo por la forma de los bloques, no por `yearGroup` | 10.3.4 |
| 4 | En cascada, promediar el bloque terminal incluyendo filas `Calculation` | 10.3.2 |
| 5 | Confiar en el promedio publicado salvo distorsión detectable | 10.4 |
| 6 | Recalcular solo si hay pesos y Σ < 100%, renormalizando | 10.4.1 |
| 7 | Detectar bloque faltante por Σ pesos < 100%, no solo por bloque vacío | 10.4.1 |
| 8 | Tratar asignaturas cualitativas como dimensión aparte | 10.2 |
| 9 | Dentro de un bloque de parciales, la numeración parte en 2: no inferir ausencias | 10.3.2 |
| 10 | Verificar la detección de CASCADA buscando la fila `Calculation` del bloque terminal | 10.3.4 |

---

---

*Las secciones 1–9 son agnósticas del colegio. La sección 10 es específica del
tenant `britishroyal`. El sustento empírico y el inventario de datos personales
están en el documento de anexos.*