import type { SchoolProfile } from '../types.js';
import { britishroyal } from './britishroyal.js';

/** Un perfil por colegio. La clave es el tenant, para poder resolver por token. */
export const PROFILES: Record<string, SchoolProfile> = { britishroyal };

export const profileFor = (id: string): SchoolProfile | undefined => PROFILES[id];
