/**
 * El bootstrap, en un solo lugar.
 *
 * El login del portal es interactivo y no se puede automatizar: es un cliente
 * público OIDC sin redirect URI registrable. Así que las credenciales las saca
 * una persona a mano, una vez, y el CLI lo único que puede hacer es explicar
 * cómo — bien, y con la ruta exacta ya puesta.
 *
 * Vive acá y no en SKILL.md porque el snippet tiene que ser el mismo para quien
 * corre el CLI en su terminal y para el modelo que lee el skill. Duplicarlo es
 * garantizar que en algún momento una de las dos copias quede vieja, y una copia
 * vieja de esto no falla ruidosamente: apaga a medias el renovador del portal y
 * el usuario pierde la cadena sin entender por qué.
 */

/**
 * ❗ El orden es funcional, no estético:
 *
 * 1. `copy()` primero — el portapapeles sobrevive a la navegación.
 * 2. Borrar la clave de sessionStorage.
 * 3. `alert()`, para que el mensaje se lea antes de que la página muera.
 * 4. `location.replace` al final.
 *
 * Los pasos 2 y 4 se necesitan los dos. Borrar la clave no alcanza porque
 * oidc-client-ts también tiene el usuario en memoria y un renew ya agendado
 * igual se dispara; `location.replace` destruye el contexto JS de la página y
 * con él todos sus timers. `replace` y no `href` para que el botón Atrás no
 * resucite la SPA. `window.close()` no sirve: Chrome solo lo permite en
 * ventanas abiertas por script y una pestaña abierta a mano lo ignora callada.
 */
export const BOOTSTRAP_SNIPPET = `;(() => {
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
    "Credenciales copiadas al portapapeles.\\n\\n" +
    "Al cerrar este aviso la pestaña quedará en blanco. Es a propósito: " +
    "evita que el portal siga renovando el token y te lo invalide.\\n\\n" +
    "Guarda el portapapeles como archivo de credenciales (NO lo pegues en el chat)."
  )
  location.replace("about:blank")
})()`;

/**
 * Las instrucciones completas, con la ruta que el usuario pidió ya sustituida.
 *
 * Se imprimen los dos destinos siempre: el CLI no sabe —ni debe saber— si lo
 * está corriendo una persona en su máquina o una tarea programada dentro de un
 * contenedor, y adivinarlo mal manda a alguien a guardar el token en el lugar
 * donde no sobrevive.
 */
export function bootstrapGuide(credentialsPath: string): string {
  return [
    'Las credenciales se sacan del navegador a mano, una sola vez. El login del',
    'portal es interactivo y no hay forma de automatizarlo.',
    '',
    '1. Abre el portal del colegio en una ventana de INCÓGNITO y entra con tu cuenta.',
    '',
    '2. Abre la consola del navegador (F12 → Console) y pega esto:',
    '',
    BOOTSTRAP_SNIPPET.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n'),
    '',
    '3. Guarda el portapapeles. NO lo pegues en un chat: no hace falta que el token',
    '   pase por ninguna conversación.',
    '',
    `     · Modo local, macOS:       pbpaste > ${credentialsPath}`,
    `     · Modo local, PowerShell:  Get-Clipboard > ${credentialsPath}`,
    '     · Tarea programada:        adjunta el archivo al proyecto como el',
    '                                documento claude/credenciales.json',
    '',
    'Dos cosas que parecen detalles y no lo son:',
    '',
    '  · La pestaña queda en blanco a propósito. El portal renueva su token solo,',
    '    en silencio, cada pocos minutos; mientras esa pestaña viva compite por la',
    '    misma cadena y te invalida la copia que acabas de sacar. Si vuelves a abrir',
    '    el portal después, esa sesión se queda con la cadena y la próxima corrida',
    '    del CLI falla.',
    '',
    '  · No hagas logout. El logout revoca la cadena y deja inservible lo copiado.',
  ].join('\n');
}
