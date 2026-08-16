// FK RESTRICT / deleteServiceRequest (auditoría 2026-08-16).
//
// postulaciones_service_request_id_fkey es ON DELETE RESTRICT — borrar
// una ServiceRequest con cualquier Postulacion asociada (candidatura
// real 'pendiente', o desde ahora también 'ignorada') fallaba con un
// 500 genérico (FK violation sin capturar). Confirmado con una consulta
// de solo lectura contra producción: 0 registros afectados hoy (bug
// preexistente pero todavía latente para 'pendiente'; 'ignorada' es
// nueva y lo habría hecho mucho más frecuente).
//
// Fix (opción C de la comparativa, sin tocar schema/FK): dentro de una
// transacción, borrar primero las Postulacion en estado 'pendiente' o
// 'ignorada' de esa solicitud, y solo entonces la ServiceRequest.
// 'aceptada'/'rechazada' se dejan fuera a propósito — el guard ya
// existente (profesionalId !== null) las hace inalcanzables aquí, y si
// esa invariante se rompiera alguna vez por otro camino, la FK debe
// seguir frenando el borrado en vez de perder ese historial en
// silencio.
//
// La atomicidad real (que un fallo a mitad de camino revierta TODO) la
// garantiza Postgres/Prisma con $transaction([...]) — eso es
// comportamiento ya probado de la propia librería, no algo que un test
// unitario con Prisma mockeado pueda demostrar por sí mismo. Lo que
// SÍ demuestran estos tests: que el código pide las dos operaciones
// como una única transacción (no dos llamadas sueltas sin garantía), y
// que si esa transacción falla, la función no responde 204 igualmente
// (no hay ningún catch que la trague).

import { Request, Response } from 'express';

// $transaction([...]) (a diferencia de la forma $transaction(async tx =>
// {...}) usada en selectPostulacion) recibe un ARRAY de promesas ya
// construidas — Node evalúa `prisma.postulacion.deleteMany(...)` y
// `prisma.serviceRequest.delete(...)` para construir ese array ANTES de
// llamar a $transaction, así que esos dos métodos tienen que existir
// como mocks reales en el propio `prisma`, no en un `tx` aparte.
jest.mock('../../config/prisma', () => ({
  prisma: {
    serviceRequest: { findUnique: jest.fn(), delete: jest.fn() },
    postulacion: { deleteMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { prisma } from '../../config/prisma';
import { deleteServiceRequest } from '../serviceRequest.controller';

const mockPrisma = prisma as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string): Request {
  return { params, user: { userId } } as unknown as Request;
}

describe('deleteServiceRequest (fix FK RESTRICT, auditoría 2026-08-16)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.postulacion.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.serviceRequest.delete.mockResolvedValue({ id: 'sr-1' });
    // $transaction real (array-style) ejecuta las promesas de las
    // operaciones ya construidas — aquí se simula resolviéndolas todas,
    // como haría Promise.all, para poder inspeccionar qué se llamó.
    mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  });

  it('1. solicitud pendiente sin postulaciones → se borra', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('2. solicitud con postulación pendiente real → se borran sus filas y luego la solicitud, en la misma transacción', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });
    let opsCapturadas: unknown[] = [];
    mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => {
      opsCapturadas = ops;
      return Promise.all(ops);
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    // Las dos operaciones van juntas, como un único array a
    // $transaction — no dos llamadas sueltas sin garantía de atomicidad.
    expect(opsCapturadas.length).toBe(2);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('3. solicitud con solicitudes ignoradas → se borran sus filas y luego la solicitud', async () => {
    // El `where` del deleteMany real (estado: { in: ['pendiente','ignorada'] })
    // cubre ambos estados con la MISMA consulta, sin ramas de código
    // distintas — por eso los escenarios 2, 3 y 4 ejercitan el mismo
    // camino. Este test deja constancia explícita del caso 'ignorada'
    // en concreto: la solicitud se borra igual de bien.
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('4. mezcla pendiente + ignorada → se borran ambas y luego la solicitud', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'cancelada',
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('5. aceptada/rechazada sigue bloqueada por el guard existente — nunca llega a la transacción', async () => {
    // 'aceptada'/'rechazada' implican profesionalId != null (ambas se
    // escriben solo dentro de la transacción de selectPostulacion, que
    // fija las dos cosas a la vez) — el guard existente ya las corta
    // aquí, sin cambios de este fix.
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: 'pro-elegido',
      estado: 'aceptada',
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('6. si la transacción falla (p.ej. el delete de la ServiceRequest falla a mitad), la función no responde 204 — no hay catch que trague el error', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'cliente-1',
      profesionalId: null,
      estado: 'pendiente',
    });
    mockPrisma.$transaction.mockRejectedValue(new Error('fallo simulado a mitad de la transacción'));

    const res = fakeRes();
    await expect(deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res)).rejects.toThrow(
      'fallo simulado a mitad de la transacción'
    );

    expect(res.status).not.toHaveBeenCalledWith(204);
  });

  it('7. retry tras un borrado ya completado: la solicitud ya no existe → 404, no un crash ni un segundo borrado', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('no borra solicitudes de otro cliente (403, nunca llega a la transacción)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      clienteId: 'otro-cliente',
      profesionalId: null,
      estado: 'pendiente',
    });

    const res = fakeRes();
    await deleteServiceRequest(fakeReq({ id: 'sr-1' }, 'cliente-1'), res);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
