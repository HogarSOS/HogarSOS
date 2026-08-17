import { prisma } from './prisma';

/**
 * Mantiene calientes las conexiones físicas del pool de Prisma contra
 * Supabase (Irlanda). Sin esto, el pool interno (mobc) cierra cada
 * conexión tras ~300s de inactividad, y la primera ráfaga de usuarios
 * tras un periodo tranquilo paga la reapertura completa (TCP+TLS+auth
 * Oregón→Irlanda, ~400-900ms por conexión) justo cuando más peticiones
 * concurrentes hay. Medido contra producción (2026-08-17, arnés v3,
 * N=25 usuarios): la MISMA ráfaga responde con P50=830ms con el pool
 * caliente y P50=2.810ms con el pool frío — la rampa fría triplica la
 * latencia de todos los endpoints a la vez, incluidos los baratos.
 *
 * Las 5 consultas van en paralelo a propósito: 5 checkouts concurrentes
 * obligan a mobc a tener las 5 conexiones abiertas; una sola consulta
 * periódica (como ya hace el tick del scheduler) solo mantiene viva 1.
 *
 * Deliberadamente NO es una TareaProgramada del scheduler: el lock en BD
 * del scheduler garantiza "solo una instancia ejecuta la tarea", y aquí
 * hace falta exactamente lo contrario — cada instancia debe calentar SU
 * propio pool. Coste: 5 consultas triviales por instancia cada 4 min.
 */

// 240s < 300s del idle-timeout de mobc, con margen para un tick perdido
// por un event loop ocupado.
const INTERVALO_MS = 240 * 1000;

/**
 * Tamaño real del pool, leído del propio `connection_limit` de
 * DATABASE_URL — si el pool crece por configuración (5→10 en la
 * auditoría de escalabilidad 2026-08-17), el warmer debe calentar TODAS
 * las conexiones, no quedarse en un número escrito a mano que dejaría
 * la mitad del pool pagando la reapertura fría en la primera ráfaga.
 */
function numConexionesDelPool(): number {
  try {
    const limite = new URL(process.env.DATABASE_URL ?? '').searchParams.get('connection_limit');
    const n = Number(limite);
    if (Number.isInteger(n) && n > 0 && n <= 50) return n;
  } catch {
    // URL ilegible — el fallback de abajo cubre este caso.
  }
  return 5;
}

const NUM_CONEXIONES = numConexionesDelPool();

let temporizador: NodeJS.Timeout | null = null;

async function calentar(): Promise<void> {
  await Promise.all(
    Array.from({ length: NUM_CONEXIONES }, () => prisma.$queryRaw`SELECT 1`)
  );
}

export function iniciarPoolWarmer(): void {
  if (temporizador) return;
  if (process.env.POOL_WARMER_ENABLED === 'false') {
    console.log('[poolWarmer] Desactivado por POOL_WARMER_ENABLED=false');
    return;
  }

  // Primer calentamiento inmediato: tras cada deploy el proceso arranca
  // con 0 conexiones abiertas — el mismo problema de la rampa fría, pero
  // garantizado para los primeros usuarios después de cada despliegue.
  calentar()
    .then(() => console.log('[poolWarmer] Pool calentado al arrancar'))
    .catch((e) => console.error('[poolWarmer] Fallo en el calentamiento inicial:', e));

  temporizador = setInterval(() => {
    calentar().catch((e) => console.error('[poolWarmer] Fallo al calentar:', e));
  }, INTERVALO_MS);
  temporizador.unref();
}

export function detenerPoolWarmer(): void {
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }
}
