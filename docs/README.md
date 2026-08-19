# Documentación de referencia

| Archivo | Qué contiene |
|---|---|
| `referencia-integracion.md` | La API completa: autenticación (§2), endpoints (§4), modos de falla (§7) e interpretación de calificaciones (§10). Las §1–9 son agnósticas del colegio; la §10 es específica del tenant. |
| `anexos.md` | Sustento empírico de lo verificado (Anexo B) e inventario de datos personales a descartar (Anexo C). |

El código referencia estas secciones en los comentarios: cuando `interpret.ts`
dice "§10.4.1", está apuntando a `referencia-integracion.md`.

Las etiquetas que usa el informe —*promedio simple*, *con porcentajes*, *en dos
pasos*— corresponden a la tabla de nomenclatura de la §10.3.

**No es documentación oficial de iSAMS.** Fue reconstruida por observación del
tráfico del portal y puede cambiar sin aviso si el proveedor actualiza la
plataforma.
