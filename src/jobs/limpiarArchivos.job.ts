import { limpiarArchivos } from '../services/archivo.service';
import { TareaProgramada } from './scheduler';

/**
 * Cierra el ciclo de vida de los archivos subidos (auditoría B4).
 *
 * Reutiliza la infraestructura de tareas programadas de B5 — no hay un
 * mecanismo nuevo de cron para esto, que era justo el requisito.
 *
 * Dos trabajos, ambos necesarios para cumplir el RGPD:
 *
 * 1. **Borrado real de las cuentas eliminadas.** `deleteMe` marca los
 *    archivos con `eliminadoAt` (y desde ese instante ya no se sirven),
 *    pero el fichero sigue en disco hasta que pasa esta tarea. Esto es
 *    lo que convierte "te hemos borrado" en verdad (Art. 17).
 *
 * 2. **Huérfanos.** Ficheros en disco sin ninguna fila que los describa:
 *    subidas abandonadas, típicamente alguien que subió su DNI y no
 *    llegó a enviar el formulario. Ya son inaccesibles por HTTP (sin
 *    fila, `servirArchivo` no puede clasificarlos y devuelve 404), pero
 *    guardar el documento de identidad de alguien "por si acaso" es
 *    conservación sin base legal, no un descuido menor.
 *
 * Diaria y no más frecuente a propósito: no hay ninguna urgencia (el
 * acceso ya está cortado en cuanto se marca) y recorrer el directorio
 * entero es la operación más cara de todas las tareas.
 */
export async function limpiarArchivosSubidos(): Promise<string> {
  const { borradosMarcados, huerfanosBorrados, fallos } = await limpiarArchivos();

  const resumen =
    `${borradosMarcados} archivo(s) de cuentas eliminadas borrados del disco, ` +
    `${huerfanosBorrados} huérfano(s) sin clasificar eliminados`;

  return fallos > 0 ? `${resumen}. ${fallos} fallo(s) de borrado — se reintentarán mañana.` : resumen;
}

export const tareaLimpiarArchivos: TareaProgramada = {
  nombre: 'limpiar-archivos-huerfanos',
  descripcion:
    'Borra del disco los archivos de cuentas eliminadas (RGPD Art. 17) y los ficheros huérfanos que ninguna fila referencia.',
  intervaloMs: 24 * 60 * 60 * 1000,
  // Recorrer el directorio entero puede tardar con muchos ficheros, y
  // hay un tope de 500 filas por pasada: holgado para que dos ejecuciones
  // no se solapen nunca.
  duracionMaximaMs: 30 * 60 * 1000,
  ejecutar: limpiarArchivosSubidos,
};
