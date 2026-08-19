# Anexos — iSAMS Parent Cloud Portal API

Complemento del documento principal. El lector que solo quiere integrarse con la
API no necesita esto; aquí está el sustento empírico y el detalle de datos
personales.

---

## Anexo B — Cobertura de la verificación

Sustento empírico de las afirmaciones marcadas ✅ en el documento principal y en
el Anexo A. Todo proviene de dos barridos de lectura del portal del tenant
`britishroyal`, sin modificar nada.

| Aspecto | Base empírica |
|---|---|
| Apoderados | 1 |
| Estudiantes | 2 |
| Niveles académicos | 2 |
| Asignaturas | 23 |
| Markbooks (incl. agregadores) | 25 |
| Columnas totales | 209 (118 `Assessment`, 91 `Calculation`) |
| Endpoints ejercitados | 3 de datos + `/auth/connect/token` + descubrimiento OIDC |

## Validaciones cuantitativas

| Afirmación | Resultado |
|---|---|
| `type=="Assessment"` ⟺ `submitted==true` | 118 / 118 exacto |
| Regla de escala por rango → nota en [1,0 ; 7,0] | 191 / 191 numéricas, 0 fuera de rango |
| Reproducción de promedios semestrales publicados | 26 / 26 |
| Reproducción de promedios finales publicados | 20 / 20 |
| Algoritmo unificado de A.4 (usar-publicado / recalcular) | 30 / 30 periodos, 0 omisiones |
| `outOf` poblado | 0 / 209 |
| Valor `Assessment` > 70 (rompería ×10) | 0 / 209 |
| Modelos de cálculo distintos coexistiendo en un nivel | confirmado (Year 10: ponderado + plano) |

## Límites de la muestra

- **Un solo tenant, un solo año.** La estructura de la API se asume portable; la
  interpretación del Anexo A no.
- **Dos niveles.** Se observaron tres modelos de cálculo; podrían existir más.
- **Sin inasistencias ni comentarios en la muestra** (`absent` y `hasComments`
  siempre `false`): su comportamiento real queda inferido, no verificado.
- **Volúmenes bajos** (≤ 30 columnas por markbook): la paginación no pudo
  descartarse.

---

## Anexo C — Inventario de datos personales

El endpoint `GET /students/portal/parents/{parentsPath}` (§4.1) devuelve ~59
campos por estudiante. La extracción académica requiere **6**. Los demás son
datos personales de menores y **deben descartarse en la normalización**.

## Campos a conservar (6)

```
schoolId · fullName (o preferredName) · formGroup · yearGroup · schoolCode · familyId
```

## Campos a descartar (~53) — contienen o exponen PII

```
dob                     homeAddresses[]        personGuid
schoolEmailAddress      personalEmailAddress   mobileNumber
gender                  nationalities          nationalitiesString
religion                ethnicity              ethnicitySource
birthplace              birthCounty            disabilities[]
medicalFlag             languages[]            languagesString
enrolmentDate           enrolmentStatus        enrolmentTerm
enrolmentYear           leavingDate            leavingReason
leavingYearGroup        admissionsStatusId     candidateCode
uniquePupilNumber       formerUniquePupilNumber futureSchoolId
latestPhotoId           latestPhotoPath        latestPhotoDirectory
tutorEmployeeId         serviceChild           boardingHouse
boardingStatus          academicHouse          title
initials               middlenames            officialName
preferredSurname        previousName           labelSalutation
letterSalutation       residentCountry         systemStatus
lastUpdated            id                     (otros)
```

Los de mayor sensibilidad: **domicilio completo** (`homeAddresses`), **fecha de
nacimiento** (`dob`), **correo escolar** (`schoolEmailAddress`), **religión**,
**etnia**, **discapacidades** y **flag médico**.

## Principio operativo

Filtrar en el punto de entrada: normalizar la respuesta a los 6 campos **antes**
de escribir a disco, log, caché o cualquier salida. Lo que nunca se persiste no
puede filtrarse. Esto aplica también a los identificadores tipo `schoolId`, que
en este contexto equivalen a un identificador nacional de un menor: no incluirlos
en material compartible.

---

*Complemento del documento iSAMS Parent Cloud Portal API. Sustento de las afirmaciones marcadas ✅ y detalle de minimización de datos.*