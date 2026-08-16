import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    professional: { findUnique: jest.fn() },
    serviceRequest: { findUnique: jest.fn() },
    postulacion: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../config/prisma';
import { enviarNotificacion } from '../../services/notification.service';
import { createPostulacion, ignorarSolicitud } from '../postulacion.controller';

const mockPrisma = prisma as any;
const mockEnviarNotificacion = enviarNotificacion as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(params: Record<string, string>, userId: string, body: Record<string, unknown>): Request {
  return { params, user: { userId }, body } as unknown as Request;
}

describe('createPostulacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.professional.findUnique.mockResolvedValue({ estadoVerificacion: 'aprobado' });
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'pendiente' });
  });

  it('crea la postulación y notifica al cliente', async () => {
    mockPrisma.postulacion.create.mockResolvedValue({ id: 'post-1', estado: 'pendiente' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Puedo ir mañana a las 10:00' }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      'nueva_postulacion',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('rechaza el mensaje si contiene un teléfono', async () => {
    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'llamame al 612345678' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('rechaza el mensaje si contiene un email', async () => {
    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'escribeme a pepe@gmail.com' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 409 si ya se había postulado antes (constraint único, fila real no era ignorada)', async () => {
    mockPrisma.postulacion.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.postulacion.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.postulacion.updateMany).toHaveBeenCalledWith({
      where: { serviceRequestId: 'sr-1', profesionalId: 'pro-1', estado: 'ignorada' },
      data: { estado: 'pendiente', mensaje: 'Disponible mañana', resueltaAt: null },
    });
  });

  it('convierte una solicitud ignorada previamente en candidatura real, sin 409', async () => {
    mockPrisma.postulacion.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.postulacion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.postulacion.findUniqueOrThrow.mockResolvedValue({ id: 'post-1', estado: 'pendiente' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Al final sí puedo' }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEnviarNotificacion).toHaveBeenCalledWith(
      'cliente-1',
      'nueva_postulacion',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('devuelve 409 si la solicitud ya no está pendiente', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'aceptada' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.postulacion.create).not.toHaveBeenCalled();
  });

  it('devuelve 403 si el profesional no está verificado', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue({ estadoVerificacion: 'pendiente' });

    const res = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Disponible mañana' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('ignorarSolicitud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'pendiente' });
  });

  it('crea la fila ignorada cuando no había ninguna candidatura previa', async () => {
    mockPrisma.postulacion.create.mockResolvedValue({ id: 'post-1', estado: 'ignorada' });

    const res = fakeRes();
    await ignorarSolicitud(fakeReq({ id: 'sr-1' }, 'pro-1', {}), res);

    expect(mockPrisma.postulacion.create).toHaveBeenCalledWith({
      data: { serviceRequestId: 'sr-1', profesionalId: 'pro-1', estado: 'ignorada' },
    });
    expect(mockPrisma.postulacion.updateMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('es idempotente: ignorar una fila YA ignorada no falla y refresca resueltaAt', async () => {
    mockPrisma.postulacion.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.postulacion.updateMany.mockResolvedValue({ count: 1 });

    const res = fakeRes();
    await ignorarSolicitud(fakeReq({ id: 'sr-1' }, 'pro-1', {}), res);

    // Condición estrecha a propósito (fix 2026-08-16, ver docstring):
    // solo convierte si la fila YA era 'ignorada' — nunca 'pendiente',
    // 'rechazada' ni 'aceptada'.
    expect(mockPrisma.postulacion.updateMany).toHaveBeenCalledWith({
      where: { serviceRequestId: 'sr-1', profesionalId: 'pro-1', estado: 'ignorada' },
      data: { estado: 'ignorada', resueltaAt: expect.any(Date) },
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it.each([
    ['aceptada', 'trabajo ya asignado'],
    ['pendiente', 'candidatura real sin resolver'],
    ['rechazada', 'candidatura real ya resuelta'],
  ])('devuelve 409 si la fila existente es "%s" (%s) — nunca se pisa con updateMany', async (estadoExistente) => {
    // count:0 simula que la fila real tiene estadoExistente (no
    // 'ignorada'), así que la condición `estado: 'ignorada'` del WHERE
    // no la alcanza — comportamiento idéntico para los tres casos,
    // ninguno pasa por una rama de código distinta.
    mockPrisma.postulacion.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.postulacion.updateMany.mockResolvedValue({ count: 0 });

    const res = fakeRes();
    await ignorarSolicitud(fakeReq({ id: 'sr-1' }, 'pro-1', {}), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_CANNOT_IGNORE' }));
    void estadoExistente;
  });

  it('devuelve 404 si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

    const res = fakeRes();
    await ignorarSolicitud(fakeReq({ id: 'sr-inexistente' }, 'pro-1', {}), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockPrisma.postulacion.upsert).not.toHaveBeenCalled();
  });
});

describe('revisión adversarial: carrera real ignorarSolicitud vs createPostulacion (misma solicitud, mismo profesional)', () => {
  // Simulación en memoria de la tabla `postulaciones` con la MISMA
  // semántica que Postgres le da a esta pareja de operaciones: create()
  // choca (P2002) si ya existe fila con esa clave única
  // (serviceRequestId, profesionalId); updateMany solo escribe si el
  // `where.estado` coincide con la fila real — igual que el índice único
  // + el WHERE condicionado del código de verdad, no una aproximación.
  //
  // No hay hilos reales en Node/Jest, así que "simultáneamente" se prueba
  // como las DOS órdenes de llegada posibles (create() de una gana la
  // carrera de Postgres, el otro pierde y cae a su updateMany) — es la
  // propiedad que importa de verdad: sea cual sea el orden real de
  // ejecución, el resultado final tiene que ser coherente y la
  // notificación ya enviada al cliente nunca debe quedar contradicha por
  // una escritura posterior.
  class TablaPostulacionesFake {
    private filas = new Map<string, any>();
    private clave(sr: string, pro: string) {
      return `${sr}:${pro}`;
    }
    async create({ data }: any) {
      const k = this.clave(data.serviceRequestId, data.profesionalId);
      if (this.filas.has(k)) {
        const err: any = new Error('Unique constraint violation');
        err.code = 'P2002';
        throw err;
      }
      // createPostulacion no pasa `estado` explícito en su create() real
      // — se apoya en el @default(pendiente) del schema. El fake tiene
      // que replicar ese default, si no una candidatura "nueva" se
      // guarda sin estado y la simulación deja de ser fiel al comportamiento real.
      const fila = { id: `post-${this.filas.size + 1}`, resueltaAt: null, mensaje: null, estado: 'pendiente', ...data };
      this.filas.set(k, fila);
      return fila;
    }
    async updateMany({ where, data }: any) {
      const k = this.clave(where.serviceRequestId, where.profesionalId);
      const fila = this.filas.get(k);
      if (!fila || fila.estado !== where.estado) return { count: 0 };
      Object.assign(fila, data);
      return { count: 1 };
    }
    async findUniqueOrThrow({ where }: any) {
      const clave = where.serviceRequestId_profesionalId;
      const fila = this.filas.get(this.clave(clave.serviceRequestId, clave.profesionalId));
      if (!fila) throw new Error('not found');
      return fila;
    }
    estadoActual(sr: string, pro: string) {
      return this.filas.get(this.clave(sr, pro))?.estado ?? null;
    }
  }

  let tabla: TablaPostulacionesFake;

  beforeEach(() => {
    jest.clearAllMocks();
    tabla = new TablaPostulacionesFake();
    mockPrisma.postulacion.create.mockImplementation((args: any) => tabla.create(args));
    mockPrisma.postulacion.updateMany.mockImplementation((args: any) => tabla.updateMany(args));
    mockPrisma.postulacion.findUniqueOrThrow.mockImplementation((args: any) => tabla.findUniqueOrThrow(args));
    mockPrisma.professional.findUnique.mockResolvedValue({ estadoVerificacion: 'aprobado' });
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', clienteId: 'cliente-1', estado: 'pendiente' });
  });

  it('orden 1: Ignorar llega primero → Candidatarme después SÍ puede convertirla en candidatura real', async () => {
    await ignorarSolicitud(fakeReq({ id: 'sr-1' }, 'pro-1', {}), fakeRes());
    expect(tabla.estadoActual('sr-1', 'pro-1')).toBe('ignorada');

    const resCandidatar = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Al final sí puedo' }), resCandidatar);

    expect(resCandidatar.status).toHaveBeenCalledWith(201);
    expect(tabla.estadoActual('sr-1', 'pro-1')).toBe('pendiente');
    expect(mockEnviarNotificacion).toHaveBeenCalledWith('cliente-1', 'nueva_postulacion', expect.any(Object), expect.any(Object));
  });

  it('orden 2 (el caso que rompía antes del fix): Candidatarme gana la carrera y queda "pendiente" → Ignorar llega después y NO puede sobrescribirla, devuelve el conflicto esperado', async () => {
    const resCandidatar = fakeRes();
    await createPostulacion(fakeReq({ id: 'sr-1' }, 'pro-1', { mensaje: 'Puedo ir mañana' }), resCandidatar);

    expect(resCandidatar.status).toHaveBeenCalledWith(201);
    expect(tabla.estadoActual('sr-1', 'pro-1')).toBe('pendiente');
    // La notificación al cliente ya salió en este punto, ANTES de que
    // ignorarSolicitud siquiera se llame.
    expect(mockEnviarNotificacion).toHaveBeenCalledTimes(1);

    const resIgnorar = fakeRes();
    await ignorarSolicitud(fakeReq({ id: 'sr-1' }, 'pro-1', {}), resIgnorar);

    // El conflicto esperado, no un 204 silencioso.
    expect(resIgnorar.status).toHaveBeenCalledWith(409);
    expect(resIgnorar.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REQUEST_CANNOT_IGNORE' }));

    // La fila sigue 'pendiente' — Ignorar NO la sobrescribió. La
    // notificación 'nueva_postulacion' ya enviada sigue siendo verdad:
    // no hay ningún cambio posterior que la contradiga.
    expect(tabla.estadoActual('sr-1', 'pro-1')).toBe('pendiente');
    expect(mockEnviarNotificacion).toHaveBeenCalledTimes(1);
  });
});
