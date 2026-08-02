jest.mock('../../config/prisma', () => ({
  prisma: {
    professional: { update: jest.fn() },
    professionalCategory: { count: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    accounts: { retrieve: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { intentarAprobacionAutomatica, sincronizarEstadoCuentaStripe, derivarEstadoCuentaStripe } from '../professional.service';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

/**
 * Roadmap económico punto 8 (aprobación semiautomática): estos tests
 * fijan los 4 requisitos exactos (perfil completo, foto, categoría,
 * Stripe configurada) para que un cambio futuro no los relaje sin darse
 * cuenta — el objetivo de diseño es ~95% de aprobaciones automáticas,
 * el 5% restante debe quedarse "pendiente" de verdad.
 */
describe('intentarAprobacionAutomatica', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const profesionalListo = (overrides: Record<string, unknown> = {}) => ({
    userId: 'prof-1',
    estadoVerificacion: 'pendiente',
    tipoProfesional: 'autonomo',
    fotoPerfilUrl: 'https://cdn.hogarsos.es/foto.jpg',
    stripeAccountId: 'acct_1',
    stripeDetailsSubmitted: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    ...overrides,
  }) as any;

  it('aprueba automáticamente cuando se cumplen los 4 requisitos', async () => {
    mockPrisma.professionalCategory.count.mockResolvedValue(1);
    mockPrisma.professional.update.mockResolvedValue({ ...profesionalListo(), estadoVerificacion: 'aprobado' });

    const resultado = await intentarAprobacionAutomatica(profesionalListo());

    expect(mockPrisma.professional.update).toHaveBeenCalledWith({
      where: { userId: 'prof-1' },
      data: expect.objectContaining({ estadoVerificacion: 'aprobado', verificadoPor: 'sistema:auto-aprobacion' }),
    });
    expect(resultado.estadoVerificacion).toBe('aprobado');
  });

  it('no aprueba si falta tipoProfesional (no completó el paso de verificación)', async () => {
    const resultado = await intentarAprobacionAutomatica(profesionalListo({ tipoProfesional: null }));

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(resultado.estadoVerificacion).toBe('pendiente');
  });

  it('no aprueba si falta la foto de perfil', async () => {
    const resultado = await intentarAprobacionAutomatica(profesionalListo({ fotoPerfilUrl: null }));

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(resultado.estadoVerificacion).toBe('pendiente');
  });

  it('no aprueba si no tiene ninguna categoría', async () => {
    mockPrisma.professionalCategory.count.mockResolvedValue(0);

    const resultado = await intentarAprobacionAutomatica(profesionalListo());

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(resultado.estadoVerificacion).toBe('pendiente');
  });

  it('no aprueba si Stripe todavía no está configurada', async () => {
    const resultado = await intentarAprobacionAutomatica(
      profesionalListo({ stripeChargesEnabled: false, stripePayoutsEnabled: false })
    );

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(mockPrisma.professionalCategory.count).not.toHaveBeenCalled();
    expect(resultado.estadoVerificacion).toBe('pendiente');
  });

  it('no reevalúa si ya estaba decidido (aprobado o rechazado por un admin)', async () => {
    const resultadoAprobado = await intentarAprobacionAutomatica(profesionalListo({ estadoVerificacion: 'aprobado' }));
    const resultadoRechazado = await intentarAprobacionAutomatica(profesionalListo({ estadoVerificacion: 'rechazado' }));

    expect(mockPrisma.professional.update).not.toHaveBeenCalled();
    expect(mockPrisma.professionalCategory.count).not.toHaveBeenCalled();
    expect(resultadoAprobado.estadoVerificacion).toBe('aprobado');
    expect(resultadoRechazado.estadoVerificacion).toBe('rechazado');
  });
});

describe('sincronizarEstadoCuentaStripe — integración con la aprobación automática', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dispara la aprobación automática cuando Stripe es lo último que faltaba', async () => {
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    mockPrisma.professional.update
      // 1ª llamada: guarda los flags de Stripe.
      .mockResolvedValueOnce({
        userId: 'prof-1',
        estadoVerificacion: 'pendiente',
        tipoProfesional: 'empresa',
        fotoPerfilUrl: 'https://cdn.hogarsos.es/foto.jpg',
        stripeAccountId: 'acct_1',
        stripeDetailsSubmitted: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      })
      // 2ª llamada: la de intentarAprobacionAutomatica — devuelve la
      // fila completa, como haría Prisma de verdad.
      .mockResolvedValueOnce({
        userId: 'prof-1',
        estadoVerificacion: 'aprobado',
        tipoProfesional: 'empresa',
        fotoPerfilUrl: 'https://cdn.hogarsos.es/foto.jpg',
        stripeAccountId: 'acct_1',
        stripeDetailsSubmitted: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      });
    mockPrisma.professionalCategory.count.mockResolvedValue(2);

    const resultado = await sincronizarEstadoCuentaStripe('prof-1', 'acct_1');

    expect(derivarEstadoCuentaStripe(resultado as any)).toBe('configurada');
    expect(resultado.estadoVerificacion).toBe('aprobado');
  });

  it('no aprueba si Stripe queda configurada pero todavía falta completar el perfil', async () => {
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    mockPrisma.professional.update.mockResolvedValue({
      userId: 'prof-1',
      estadoVerificacion: 'pendiente',
      tipoProfesional: null, // todavía no completó "Mi perfil"
      fotoPerfilUrl: null,
      stripeAccountId: 'acct_1',
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });

    const resultado = await sincronizarEstadoCuentaStripe('prof-1', 'acct_1');

    expect(resultado.estadoVerificacion).toBe('pendiente');
    expect(mockPrisma.professional.update).toHaveBeenCalledTimes(1); // solo el update de los flags de Stripe
  });
});
