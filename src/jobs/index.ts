import { TareaProgramada } from './scheduler';
import { tareaReintentarPagosAtascados } from './reintentarPagosAtascados.job';
import { tareaAutorizacionesPorCaducar } from './autorizacionesPorCaducar.job';
import { tareaLimpiarArchivos } from './limpiarArchivos.job';

/**
 * Registro único de tareas programadas.
 *
 * Añadir una tarea nueva es: crear `src/jobs/loQueSea.job.ts` exportando
 * un `TareaProgramada`, e importarlo aquí. Nada más — ni tocar index.ts,
 * ni el motor, ni las rutas de admin, que ya recorren este array.
 */
export const TAREAS: TareaProgramada[] = [
  tareaReintentarPagosAtascados,
  tareaAutorizacionesPorCaducar,
  tareaLimpiarArchivos,
];

export { iniciarScheduler, detenerScheduler, ejecutarTareasPendientes, ejecutarTareaAhora } from './scheduler';
export type { TareaProgramada } from './scheduler';
