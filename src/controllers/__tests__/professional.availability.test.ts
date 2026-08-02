import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    professional: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    accounts: { retrieve: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { updateAvailability } from '../professional.controller';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(userId: string, body: Record<string, unknown>): Request {
  return { params: {}, user: { userId }, body } as unknown as Request;
}

/**
 * Roadmap económico punto 5: Registro → (Verificación + Stripe en
 * paralelo) → Disponible para trabajar. "Disponible" es el punto de
 * llegada de las DOS ramas — estos tests fijan ese comportamiento para
 * que no se rompa sin darse cuenta en un refactor futuro.
 */
describe('updateAvailability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.professional.update.mockResolvedValue({});
  });

  const profesionalBase = (overrides: Record<string, unknown> = {}) => ({
    userId: 'prof-1',
    estadoVerificacion: 'aprobado',
    modoDisponibilidad: 'horario_laboral',
    stripeAccountId: 'acct_1',
    stripeDetailsSubmitted: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    ...overrides,
  });

  it('devuelve 403 PROFESSIONAL_NOT_VERIFIED si no está aprobado (comportamiento ya existente)', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(profesionalBase({ estadoVerificacion: 'pendiente' }));

    const res = fakeRes();
    await updateAvailability(fakeReq('prof-1', { disponible: true }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROFESSIONAL_NOT_VERIFIED' }));
    expect(mockStripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('devuelve 403 PROFESSIONAL_STRIPE_NOT_CONFIGURED si está aprobado pero Stripe no está configurado', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(
      profesionalBase({ stripeChargesEnabled: false, stripePayoutsEnabled: false })
    );
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: false,
      payouts_enabled: false,
    });
    // La actualización de sincronizarEstadoCuentaStripe devuelve la fila
    // completa (como haría Prisma de verdad) — sin esto, intentarAprobacionAutomatica
    // ve un objeto vacío y el gate de verificación se dispara antes de
    // tiempo con datos falsos.
    mockPrisma.professional.update.mockResolvedValue(
      profesionalBase({ stripeChargesEnabled: false, stripePayoutsEnabled: false })
    );

    const res = fakeRes();
    await updateAvailability(fakeReq('prof-1', { disponible: true }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROFESSIONAL_STRIPE_NOT_CONFIGURED' }));
  });

  it('permite ponerse disponible cuando está aprobado Y Stripe configurado', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(profesionalBase());

    const res = fakeRes();
    await updateAvailability(fakeReq('prof-1', { disponible: true }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockPrisma.professional.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'prof-1' }, data: expect.objectContaining({ disponible: true }) })
    );
  });

  it('re-sincroniza en caliente con Stripe antes de bloquear — evita un falso negativo si el webhook aún no llegó', async () => {
    // BD desactualizada (todavía en false) pero Stripe ya dice que está todo listo.
    mockPrisma.professional.findUnique.mockResolvedValue(
      profesionalBase({ stripeDetailsSubmitted: false, stripeChargesEnabled: false, stripePayoutsEnabled: false })
    );
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    mockPrisma.professional.update
      // Primera llamada: la del re-sync (sincronizarEstadoCuentaStripe) —
      // devuelve la fila completa, como haría Prisma de verdad.
      .mockResolvedValueOnce(
        profesionalBase({ stripeDetailsSubmitted: true, stripeChargesEnabled: true, stripePayoutsEnabled: true })
      )
      // Segunda llamada: la del propio updateAvailability, ya sin bloqueo.
      .mockResolvedValueOnce({});

    const res = fakeRes();
    await updateAvailability(fakeReq('prof-1', { disponible: true }), res);

    expect(mockStripe.accounts.retrieve).toHaveBeenCalledWith('acct_1');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('nunca bloquea ponerse NO disponible, sin importar verificación ni Stripe', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(
      profesionalBase({ estadoVerificacion: 'pendiente', stripeChargesEnabled: false, stripePayoutsEnabled: false })
    );

    const res = fakeRes();
    await updateAvailability(fakeReq('prof-1', { disponible: false }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockStripe.accounts.retrieve).not.toHaveBeenCalled();
  });
});
