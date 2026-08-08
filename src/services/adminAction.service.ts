import { prisma } from '../config/prisma';

/**
 * Auditoría centralizada del panel admin (Bloque 4). Antes cada acción
 * de admin (bloquear usuario, aprobar profesional, resolver disputa)
 * cambiaba el estado sin dejar rastro de quién lo hizo ni cuándo — solo
 * quedaba el estado final, nunca el historial.
 *
 * Se llama DESPUÉS de que el cambio de estado ya se aplicó con éxito: si
 * el registro de auditoría fallara, no debe impedir ni deshacer la
 * acción real (bloquear a un usuario es más importante que registrar que
 * se bloqueó). Por eso nunca se usa dentro de la misma transacción que
 * el cambio de estado.
 */
export async function registrarAccionAdmin(params: {
  adminId: string;
  accion: string;
  entidadTipo: string;
  entidadId: string;
  estadoAnterior?: string | null;
  estadoNuevo?: string | null;
  detalle?: string | null;
}) {
  try {
    await prisma.adminAction.create({
      data: {
        adminId: params.adminId,
        accion: params.accion,
        entidadTipo: params.entidadTipo,
        entidadId: params.entidadId,
        estadoAnterior: params.estadoAnterior ?? null,
        estadoNuevo: params.estadoNuevo ?? null,
        detalle: params.detalle ?? null,
      },
    });
  } catch (err) {
    // No relanzar: un fallo al auditar no puede tumbar la petición ni
    // dar la impresión de que la acción real (ya aplicada) falló.
    console.error('[registrarAccionAdmin] No se pudo registrar la acción de auditoría:', err);
  }
}

/**
 * Listado paginado para el panel ("qué ha hecho cada admin"). Filtros
 * opcionales por entidad (para ver el historial de un usuario/profesional/
 * disputa concreto) o por admin.
 */
export async function listarAccionesAdmin(params: {
  entidadTipo?: string;
  entidadId?: string;
  adminId?: string;
  limite?: number;
}) {
  const limite = Math.min(params.limite ?? 50, 200);

  return prisma.adminAction.findMany({
    where: {
      ...(params.entidadTipo ? { entidadTipo: params.entidadTipo } : {}),
      ...(params.entidadId ? { entidadId: params.entidadId } : {}),
      ...(params.adminId ? { adminId: params.adminId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limite,
  });
}
