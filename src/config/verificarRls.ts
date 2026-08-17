import { prisma } from './prisma';

/**
 * Auditoría adversarial 2026-08-17, B-02: tres veces seguidas una tabla
 * nueva se ha colado sin `ENABLE ROW LEVEL SECURITY` (las 15 originales,
 * admin_actions, user_fcm_tokens) porque no había ninguna comprobación
 * automática que lo impidiera. Esto sustituye la memoria humana por una
 * consulta real contra la base de datos en cada arranque.
 *
 * No bloquea el arranque ni repite la consulta por petición (eso
 * agravaría B-01): se ejecuta una sola vez, en segundo plano, después de
 * que el servidor ya esté escuchando, y solo deja un aviso en el log si
 * encuentra alguna tabla desprotegida.
 */
export async function verificarRlsAlArrancar(): Promise<void> {
  try {
    const tablasSinRls = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname != '_prisma_migrations'
        AND c.relrowsecurity = false
    `;

    if (tablasSinRls.length > 0) {
      const nombres = tablasSinRls.map((t) => t.tablename).join(', ');
      console.error(
        `[verificarRls] ⚠️  ${tablasSinRls.length} tabla(s) de public sin Row Level Security: ${nombres}. ` +
          'Ejecuta una migración con ALTER TABLE ... ENABLE ROW LEVEL SECURITY (ver B-02, auditoría 2026-08-17).'
      );
    } else {
      console.log('[verificarRls] OK — todas las tablas de public tienen RLS activado.');
    }
  } catch (e) {
    console.error('[verificarRls] No se pudo comprobar RLS al arrancar:', e);
  }
}
