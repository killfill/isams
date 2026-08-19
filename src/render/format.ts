const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
               'septiembre','octubre','noviembre','diciembre'];

/** "19 de agosto de 2026, 15:59" en la zona horaria indicada. */
export function fechaLarga(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('es-CL', {
    timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('day')} de ${MESES[Number(g('month')) - 1]} de ${g('year')}, ${g('hour')}:${g('minute')}`;
}
