import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

// professional.controller.ts (y professional.service.ts) importan
// config/stripe, que revienta en test por faltar STRIPE_SECRET_KEY real —
// mismo patrón que serviceRequest.nearby.test.ts.
jest.mock('../../config/stripe', () => ({
  stripe: { accounts: { retrieve: jest.fn() } },
}));

// sincronizarEstadoCuentaStripe se mockea (toca Stripe y la BD);
// derivarEstadoCuentaStripe se usa REAL (pura) vía requireActual, para que
// el test cubra la derivación de verdad y no una copia.
jest.mock('../../services/professional.service', () => {
  const real = jest.requireActual('../../services/professional.service');
  return {
    ...real,
    sincronizarEstadoCuentaStripe: jest.fn(),
    intentarAprobacionAutomatica: jest.fn(),
  };
});

import { prisma } from '../../config/prisma';
import { sincronizarEstadoCuentaStripe } from '../../services/professional.service';
import { getProfile } from '../professional.controller';

const mockPrisma = prisma as any;
const mockSincronizar = sincronizarEstadoCuentaStripe as jest.Mock;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string): Request {
  return { user: { userId, role: 'profesional' } } as unknown as Request;
}

/** Fila tal como la entrega la consulta fusionada (ver FilaPerfilProfesional). */
function fila(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    estadoVerificacion: 'aprobado',
    tipoProfesional: 'autonomo',
    tarifaBase: new Prisma.Decimal('25.50'),
    valoracionMedia: new Prisma.Decimal('4.75'),
    totalTrabajos: 12,
    disponible: true,
    modoDisponibilidad: 'horario_laboral',
    descripcion: 'Electricista con 10 años de experiencia',
    fotoPerfilUrl: 'https://x/foto.jpg',
    documentoIdentidadUrl: null,
    stripeAccountId: null,
    stripeDetailsSubmitted: false,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    userNombre: 'Paco',
    userEmail: 'paco@example.com',
    userTelefono: '+34600000000',
    categorias: ['Electricista', 'Fontanería'],
    opiniones: [
      // `fecha` llega como string ISO con Z generada por to_char en el SQL —
      // regresión explícita del bug de fechas sin Z encontrado en la fusión v3.
      { autor: 'Cliente 1', puntuacion: 5, comentario: 'Genial', fecha: '2026-08-17T13:22:22.228Z' },
    ],
    ...overrides,
  };
}

describe('getProfile (fusión SQL 6→1 round-trips)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('usa una sola llamada $queryRaw y mapea la fila al contrato del endpoint', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([fila()]);
    const res = fakeRes();

    await getProfile(fakeReq('prof-1'), res);

    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      nombre: 'Paco',
      email: 'paco@example.com',
      telefono: '+34600000000',
      estadoVerificacion: 'aprobado',
      tipoProfesional: 'autonomo',
      tarifaBase: 25.5,
      valoracionMedia: 4.75,
      totalTrabajos: 12,
      disponible: true,
      modoDisponibilidad: 'horario_laboral',
      descripcion: 'Electricista con 10 años de experiencia',
      fotoPerfilUrl: 'https://x/foto.jpg',
      documentoIdentidadUrl: null,
      categorias: ['Electricista', 'Fontanería'],
      estadoCuentaStripe: 'pendiente',
      opiniones: [
        { autor: 'Cliente 1', puntuacion: 5, comentario: 'Genial', fecha: '2026-08-17T13:22:22.228Z' },
      ],
    });
  });

  it('devuelve 404 si la consulta no devuelve ninguna fila', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const res = fakeRes();

    await getProfile(fakeReq('no-existe'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PROFESSIONAL_PROFILE_NOT_FOUND' })
    );
  });

  it('no toca Stripe si el profesional no tiene stripeAccountId', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([fila()]);

    await getProfile(fakeReq('prof-1'), fakeRes());

    expect(mockSincronizar).not.toHaveBeenCalled();
  });

  it('no toca Stripe si la cuenta ya está completamente habilitada', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      fila({
        stripeAccountId: 'acct_1',
        stripeDetailsSubmitted: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      }),
    ]);
    const res = fakeRes();

    await getProfile(fakeReq('prof-1'), res);

    expect(mockSincronizar).not.toHaveBeenCalled();
    expect((res.json as jest.Mock).mock.calls[0][0].estadoCuentaStripe).toBe('configurada');
  });

  it('sincroniza con Stripe cuando la cuenta existe pero no está habilitada, y aplica el resultado', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([fila({ stripeAccountId: 'acct_1' })]);
    mockSincronizar.mockResolvedValue({
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    const res = fakeRes();

    await getProfile(fakeReq('prof-1'), res);

    expect(mockSincronizar).toHaveBeenCalledWith('prof-1', 'acct_1');
    expect((res.json as jest.Mock).mock.calls[0][0].estadoCuentaStripe).toBe('configurada');
  });

  it('si la sincronización con Stripe falla, responde igualmente con el estado de BD', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([fila({ stripeAccountId: 'acct_1' })]);
    mockSincronizar.mockRejectedValue(new Error('stripe caído'));
    const res = fakeRes();

    await getProfile(fakeReq('prof-1'), res);

    expect((res.json as jest.Mock).mock.calls[0][0].estadoCuentaStripe).toBe('pendiente');
  });

  it('normaliza documentoIdentidadUrl vacío a null (mismo comportamiento que antes de la fusión)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([fila({ documentoIdentidadUrl: '' })]);
    const res = fakeRes();

    await getProfile(fakeReq('prof-1'), res);

    expect((res.json as jest.Mock).mock.calls[0][0].documentoIdentidadUrl).toBeNull();
  });
});
