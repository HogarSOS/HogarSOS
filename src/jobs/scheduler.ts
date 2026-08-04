import { prisma } from '../config/prisma';

/**
 * Motor de tareas programadas de hogarSOS.
 *
 * POR QUÉ IN-PROCESS Y NO UN SERVICIO APARTE
 * ------------------------------------------
 * Un Render Cron Job cuesta ~7 $/mes POR TAREA, con su propio deploy y
 * su propia copia de las variables de entorno; un Background Worker es
 * un proceso permanente ocioso el 99,9% del tiempo. Con dos tareas (y
 * más por venir) eso multiplica coste y superficie de configuración sin
 * aportar nada que no se pueda garantizar aquí.
 *
 * La única objeción real al modelo in-process es que, con más de una
 * instancia del backend, cada una ejecutaría la misma tarea. Eso se
 * cierra con `bloqueadoHasta` (lock en base de datos con expiración) —
 * el mismo patrón de lease que usa la liberación de pagos, para no
 * tener dos mecanismos distintos de exclusión mutua en el proyecto.
 *
 * Y no cierra ninguna puerta: si algún día conviene moverlo a un cron
 * de verdad, ese entrypoint nuevo solo tiene que llamar a
 * `ejecutarTareasPendientes()`. Las tareas no se enteran.
 *
 * GARANTÍAS
 * ---------
 * - Nunca dos ejecuciones simultáneas de la misma tarea (lock atómico).
 * - Nunca bloqueada para siempre: el lock caduca a `duracionMaximaMs`,
 *   así que un reinicio de Render en pleno vuelo se recupera solo.
 * - Un fallo en una tarea NUNCA tumba la API ni impide que corran las
 *   demás: cada una va en su propio try/catch.
 * - Una tarea lenta no se solapa consigo misma: mientras tenga el lock,
 *   el siguiente tick la salta.
 * - El calendario vive en BD, no en el uptime del proceso: un redeploy
 *   no vuelve a disparar todas las tareas desde cero.
 */

export interface TareaProgramada {
  /** Identificador estable — es la clave primaria en BD. Cambiarlo reinicia el historial de esa tarea. */
  nombre: string;
  /** Qué hace, en una línea. Se muestra tal cual en GET /api/admin/jobs. */
  descripcion: string;
  /** Cada cuánto debe ejecutarse. */
  intervaloMs: number;
  /**
   * Cuánto puede durar como máximo antes de darse por muerta y dejar
   * que otra ejecución la retome. Debe ser holgadamente mayor que la
   * duración real esperada: si se queda corto, dos procesos podrían
   * solaparse sobre la misma tarea.
   */
  duracionMaximaMs: number;
  /** Devuelve un resumen legible de lo que hizo, para el panel de admin. */
  ejecutar: () => Promise<string>;
}

/** Cada cuánto se comprueba si alguna tarea toca. No es la frecuencia de las tareas: cada una tiene su propio `intervaloMs`. */
const INTERVALO_TICK_MS = 60 * 1000;

let temporizador: NodeJS.Timeout | null = null;
let parando = false;

/**
 * Intenta tomar el lock de una tarea. El `updateMany` condicional es la
 * única sección crítica: si dos procesos entran a la vez, solo uno ve
 * `count > 0`.
 *
 * El `upsert` previo crea la fila la primera vez sin condiciones de
 * carrera problemáticas: si dos procesos la crean a la vez, uno recibe
 * un error de clave duplicada que se ignora — la fila queda creada
 * igual, que es lo único que importa, y el lock real se decide después.
 */
async function intentarTomarLock(tarea: TareaProgramada): Promise<boolean> {
  const ahora = new Date();

  await prisma.tareaProgramada
    .upsert({ where: { nombre: tarea.nombre }, create: { nombre: tarea.nombre }, update: {} })
    .catch(() => undefined);

  const vencimientoIntervalo = new Date(ahora.getTime() - tarea.intervaloMs);

  const { count } = await prisma.tareaProgramada.updateMany({
    where: {
      nombre: tarea.nombre,
      // Nadie la está ejecutando (o el lock de quien lo tenía ya caducó).
      OR: [{ bloqueadoHasta: null }, { bloqueadoHasta: { lt: ahora } }],
      // Y le toca: nunca se ejecutó, o ha pasado su intervalo. Este es
      // el filtro que hace que el calendario sobreviva a los reinicios.
      AND: [{ OR: [{ ultimaEjecucionAt: null }, { ultimaEjecucionAt: { lt: vencimientoIntervalo } }] }],
    },
    data: { bloqueadoHasta: new Date(ahora.getTime() + tarea.duracionMaximaMs) },
  });

  return count > 0;
}

async function registrarResultado(nombre: string, resultado: string): Promise<void> {
  await prisma.tareaProgramada.update({
    where: { nombre },
    data: {
      bloqueadoHasta: null,
      ultimaEjecucionAt: new Date(),
      ultimoResultado: resultado.slice(0, 500),
      ultimoError: null,
      ejecuciones: { increment: 1 },
      fallosConsecutivos: 0,
    },
  });
}

async function registrarFallo(nombre: string, error: unknown): Promise<void> {
  const mensaje = error instanceof Error ? error.message : String(error);

  // `ultimaEjecucionAt` se actualiza TAMBIÉN cuando falla, a propósito:
  // si no, la tarea seguiría "vencida" y se reintentaría en cada tick
  // (cada minuto) en vez de esperar su intervalo — convirtiendo un fallo
  // persistente en un martilleo contra Stripe o la BD.
  await prisma.tareaProgramada.update({
    where: { nombre },
    data: {
      bloqueadoHasta: null,
      ultimaEjecucionAt: new Date(),
      ultimoError: mensaje.slice(0, 500),
      ejecuciones: { increment: 1 },
      fallosConsecutivos: { increment: 1 },
    },
  });
}

/**
 * Ejecuta las tareas a las que les toca. Público a propósito: es el
 * punto de entrada tanto del ticker interno como de un futuro cron
 * externo o del endpoint manual del panel de admin.
 */
export async function ejecutarTareasPendientes(tareas: TareaProgramada[]): Promise<void> {
  for (const tarea of tareas) {
    if (parando) return;

    try {
      if (!(await intentarTomarLock(tarea))) continue;
    } catch (e) {
      // Un fallo consultando la BD no debe impedir que se intenten las
      // demás tareas ni, mucho menos, tumbar el proceso.
      console.error(`[scheduler] No se pudo evaluar la tarea "${tarea.nombre}":`, e);
      continue;
    }

    const inicio = Date.now();
    try {
      const resultado = await tarea.ejecutar();
      await registrarResultado(tarea.nombre, resultado);
      console.log(`[scheduler] "${tarea.nombre}" ok en ${Date.now() - inicio}ms — ${resultado}`);
    } catch (e) {
      console.error(`[scheduler] "${tarea.nombre}" falló tras ${Date.now() - inicio}ms:`, e);
      await registrarFallo(tarea.nombre, e).catch((err) =>
        console.error(`[scheduler] Tampoco se pudo registrar el fallo de "${tarea.nombre}":`, err)
      );
    }
  }
}

/**
 * Fuerza la ejecución de una tarea concreta saltándose el intervalo
 * (pero NO el lock — si está corriendo ahora mismo, no se duplica).
 * Lo usa el panel de admin para no tener que esperar al siguiente ciclo.
 */
export async function ejecutarTareaAhora(tarea: TareaProgramada): Promise<string> {
  const ahora = new Date();

  await prisma.tareaProgramada
    .upsert({ where: { nombre: tarea.nombre }, create: { nombre: tarea.nombre }, update: {} })
    .catch(() => undefined);

  const { count } = await prisma.tareaProgramada.updateMany({
    where: {
      nombre: tarea.nombre,
      OR: [{ bloqueadoHasta: null }, { bloqueadoHasta: { lt: ahora } }],
    },
    data: { bloqueadoHasta: new Date(ahora.getTime() + tarea.duracionMaximaMs) },
  });

  if (count === 0) throw new Error('TAREA_YA_EN_CURSO');

  try {
    const resultado = await tarea.ejecutar();
    await registrarResultado(tarea.nombre, resultado);
    return resultado;
  } catch (e) {
    await registrarFallo(tarea.nombre, e).catch(() => undefined);
    throw e;
  }
}

/**
 * Arranca el ticker. Se llama una sola vez, desde index.ts, después de
 * que el servidor esté escuchando.
 */
export function iniciarScheduler(tareas: TareaProgramada[]): void {
  if (temporizador) return;

  parando = false;
  console.log(`[scheduler] Iniciado con ${tareas.length} tarea(s): ${tareas.map((t) => t.nombre).join(', ')}`);

  temporizador = setInterval(() => {
    // El ticker no espera al resultado (no hay a quién devolvérselo) pero
    // sí captura el fallo: una promesa rechazada sin manejar aquí sería
    // un unhandledRejection en cada ciclo.
    ejecutarTareasPendientes(tareas).catch((e) => console.error('[scheduler] Ciclo fallido:', e));
  }, INTERVALO_TICK_MS);

  // Sin esto, el temporizador mantendría vivo el event loop e impediría
  // que el proceso terminase de forma natural.
  temporizador.unref();
}

/**
 * Detiene el ticker. Se llama al recibir SIGTERM, ANTES de cerrar el
 * servidor HTTP: así no se empieza trabajo nuevo mientras Render está
 * tumbando el contenedor. Las tareas ya en vuelo terminan solas o, si
 * el contenedor muere antes, su lock caduca y otra instancia las retoma.
 */
export function detenerScheduler(): void {
  parando = true;
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }
}
