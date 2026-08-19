import type { SchoolProfile } from '../types.js';

/**
 * Perfil de britishroyal (colegio chileno, escala 1,0–7,0).
 *
 * Corresponde a la §10 de la referencia de integración. Las §1–9 son agnósticas
 * del colegio: para otra instalación se escribe otro perfil y NO se toca el
 * resto del pipeline.
 *
 * Lo que NO va acá, a propósito: nombres de periodo ("Semestre 1"), de bloque
 * ("Prueba de Unidad (70%)") ni de asignatura. Todos esos son cadenas opacas que
 * se descubren en runtime desde las respuestas (§5). Codificarlos en duro es
 * exactamente lo que rompe la portabilidad.
 */
export const britishroyal: SchoolProfile = {
  id: 'britishroyal',

  scale: { min: 1.0, max: 7.0, pass: 4.0, centesimalAbove: 7 },

  aggregatorPrefix: 'Promedios de Asignaturas',
  averageNameHint: 'promedio',

  modelLabels: {
    simple: {
      label: 'promedio simple',
      description:
        'Se suman todas las notas del semestre y se dividen. Todas valen igual.',
    },
    weighted: {
      label: 'con porcentajes',
      description:
        'Las pruebas de unidad valen 70% del semestre y las evaluaciones de proceso, 30%, sin importar cuántas haya de cada una.',
    },
    twoStep: {
      label: 'en dos pasos',
      description:
        'Primero las evaluaciones de proceso se promedian aparte, en una sola nota —marcada con = en la tabla—. Después esa nota entra al promedio junto a las notas parciales, valiendo lo mismo que cada una.',
    },
  },

  strings: {
    title: 'Notas',
    heavierBlockNote:
      'Marca el grupo que más influye en el promedio: cada nota ahí pesa más que una evaluación de proceso. Pasa el cursor sobre cualquier nota para ver a qué grupo pertenece.',
    distortionNote:
      'Los promedios tachados en ocre son los que publica el colegio y están mal: cuando un bloque con peso todavía no tiene notas, la plataforma lo pondera como cero en vez de excluirlo, y el promedio se hunde. El número grande es el valor renormalizado sobre los bloques que sí tienen notas. Los promedios marcados est corresponden a semestres en curso y se moverán con cada nota nueva.',
  },
};
