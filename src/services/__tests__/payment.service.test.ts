jest.mock('../../config/prisma', () => ({
  prisma: {
    payment: { findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    serviceRequest: { findUnique: jest.fn() },
    professional: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: { capture: jest.fn(), cancel: jest.fn(), create: jest.fn(), retrieve: jest.fn() },
    transfers: { create: jest.fn() },
    accounts: { retrieve: jest.fn() },
    balance: { retrieve: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { releasePayments, refundPayment, calcularDesglose, obtenerResumenPagos } from '../payment.service';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

describe('calcularDesglose', () => {
  it('calcula lo que paga el cliente (base+5%) y lo que recibe el profesional (base-5%) con el fallback por defecto', () => {
    const { montoBase, montoTotalCliente, montoProfesional, comisionPlataforma } = calcularDesglose(100);
    expect(montoBase).toBe(100);
    expect(montoTotalCliente).toBe(105);
    expect(montoProfesional).toBe(95);
    expect(comisionPlataforma).toBe(10);
  });
});

describe('releasePayments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const solicitudConProfesional = {
    id: 'sr-1',
    profesional: { userId: 'prof-1', stripeAccountId: 'acct_pro_1' },
  };

  // Por defecto, todos los tests de captura/transferencia asumen una
  // cuenta Connect ya operativa — sincronizarEstadoCuentaStripe() se
  // llama de verdad dentro de releasePayments() (ver comentario en
  // payment.service.ts), así que hay que mockear tanto la consulta a
  // Stripe como el update en BD, no solo el resultado final.
  beforeEach(() => {
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    });
    mockPrisma.professional.update.mockResolvedValue({
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    // Idem para el PaymentIntent de cada autorización: por defecto, ya
    // confirmado de verdad por el cliente (requires_capture) — los
    // tests de la incidencia real (cliente nunca confirmó el Payment
    // Sheet) lo sobreescriben explícitamente.
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
  });

  // Por defecto representa una autorización con base=100 (cliente 105, profesional 95).
  const pagoRetenido = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    estado: 'retenido',
    stripePaymentIntentId: 'pi_123',
    montoBase: 100,
    montoTotal: 105,
    montoProfesional: 95,
    ...overrides,
  });

  /**
   * Regresión directa del bug del Sprint 3: stripe.transfers.create()
   * exige el ID del CHARGE (ch_...), no el del PaymentIntent (pi_...).
   */
  it('usa el charge capturado (latest_charge), no el PaymentIntent, como source_transaction', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 100);

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_transaction: 'ch_456' })
    );
  });

  it('extrae el id si latest_charge llega expandido como objeto en vez de string', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: { id: 'ch_999' } });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 100);

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_transaction: 'ch_999' })
    );
  });

  it('captura el total autorizado cuando la base final lo cubre exactamente (caso "cerrado")', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 100);

    // Sin amount_to_capture — captura completa, no parcial.
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith('pi_123', undefined);
    // Se transfiere el montoProfesional YA FIJADO en la autorización (95€), no recalculado.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, destination: 'acct_pro_1' })
    );
  });

  it('captura parcial cuando la base final es menor que la autorizada (horas reales por debajo de las estimadas), escalando proporcionalmente lo ya fijado', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]); // base autorizada 100 (cliente 105, profesional 95)
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 75); // se autorizó una base de 100, solo se consume una base de 75 (75% de la autorización)

    // 75% de 105€ cobrados al cliente = 78.75€
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith('pi_123', { amount_to_capture: 7875 });
    // 75% de los 95€ que iba a recibir el profesional = 71.25€ — proporción fijada en la autorización, no recalculada con el % vigente.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7125 })
    );
  });

  it('reparte entre varias autorizaciones (inicial + ampliación) hasta cubrir la base final, y cancela la sobrante', async () => {
    const pagoInicial = pagoRetenido({ id: 'pago-1', stripePaymentIntentId: 'pi_inicial', montoBase: 100, montoTotal: 105, montoProfesional: 95 });
    const pagoAmpliacion = pagoRetenido({
      id: 'pago-2',
      ampliacionId: 'ampl-1',
      stripePaymentIntentId: 'pi_ampliacion',
      montoBase: 50,
      montoTotal: 52.5,
      montoProfesional: 47.5,
    });
    mockPrisma.payment.findMany.mockResolvedValue([pagoInicial, pagoAmpliacion]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture
      .mockResolvedValueOnce({ id: 'pi_inicial', latest_charge: 'ch_1' })
      .mockResolvedValueOnce({ id: 'pi_ampliacion', latest_charge: 'ch_2' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    // Base final 120: cubre los 100 de base de la inicial completos + 20 de los 50 de base de la ampliación (40%).
    await releasePayments('sr-1', 120);

    expect(mockStripe.paymentIntents.capture).toHaveBeenNthCalledWith(1, 'pi_inicial', undefined);
    // 40% de los 52.5€ autorizados en la ampliación = 21€.
    expect(mockStripe.paymentIntents.capture).toHaveBeenNthCalledWith(2, 'pi_ampliacion', { amount_to_capture: 2100 });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('cancela sin cobrar las autorizaciones que sobran una vez cubierta la base final', async () => {
    const pagoInicial = pagoRetenido({ id: 'pago-1', stripePaymentIntentId: 'pi_inicial', montoBase: 100, montoTotal: 105, montoProfesional: 95 });
    const pagoAmpliacion = pagoRetenido({
      id: 'pago-2',
      ampliacionId: 'ampl-1',
      stripePaymentIntentId: 'pi_ampliacion',
      montoBase: 50,
      montoTotal: 52.5,
      montoProfesional: 47.5,
    });
    mockPrisma.payment.findMany.mockResolvedValue([pagoInicial, pagoAmpliacion]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_inicial', latest_charge: 'ch_1' });
    mockStripe.paymentIntents.cancel.mockResolvedValue({ id: 'pi_ampliacion', status: 'canceled' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    // Base final 90: cubre el 90% de la base de la inicial, la ampliación sobra entera.
    await releasePayments('sr-1', 90);

    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    // 90% de los 105€ autorizados en la inicial = 94.5€.
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith('pi_inicial', { amount_to_capture: 9450 });
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_ampliacion');
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pago-2' }, data: expect.objectContaining({ estado: 'reembolsado' }) })
    );
  });

  it('lanza PAGO_NO_ENCONTRADO si no hay ninguna autorización retenida', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);
    await expect(releasePayments('sr-sin-pago', 100)).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('lanza PROFESIONAL_SIN_CUENTA_STRIPE si el profesional no completó el onboarding de Connect', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ id: 'sr-1', profesional: { stripeAccountId: null } });
    await expect(releasePayments('sr-1', 100)).rejects.toThrow('PROFESIONAL_SIN_CUENTA_STRIPE');
  });

  it('lanza PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA si la cuenta existe pero Stripe todavía no le habilitó los payouts', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    // Cuenta creada pero onboarding sin terminar / Stripe pidió más documentación.
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: false,
    });
    mockPrisma.professional.update.mockResolvedValue({
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: false,
    });

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA');
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });

  /**
   * Bug real detectado al revisar el flujo de pagos (2026-08-03):
   * `createEscrowPaymentIntent` marca la fila como 'retenido' en cuanto
   * se crea el PaymentIntent en Stripe, ANTES de que el cliente confirme
   * el Payment Sheet — si lo abandona, la fila se queda 'retenido' en BD
   * para siempre aunque Stripe nunca haya autorizado nada. Antes de este
   * fix, intentar liberar ese pago hacía fallar `paymentIntents.capture()`
   * con un error genérico de Stripe a mitad del bucle.
   */
  it('lanza PAGO_NO_AUTORIZADO_TODAVIA si el cliente nunca confirmó el Payment Sheet (PaymentIntent no está en requires_capture)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoRetenido()]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('PAGO_NO_AUTORIZADO_TODAVIA');
    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });
});

describe('refundPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cancela TODAS las autorizaciones retenidas (inicial + ampliaciones) y las marca como reembolsadas', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', stripePaymentIntentId: 'pi_1' },
      { id: 'pago-2', stripePaymentIntentId: 'pi_2' },
    ]);
    mockStripe.paymentIntents.cancel.mockResolvedValue({ status: 'canceled' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'reembolsado' });

    await refundPayment('sr-1');

    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_1');
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_2');
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 'pago-1' }, data: { estado: 'reembolsado' } });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({ where: { id: 'pago-2' }, data: { estado: 'reembolsado' } });
  });

  it('lanza PAGO_NO_ENCONTRADO si la solicitud nunca llegó a tener un pago autorizado', async () => {
    // Caso real: cancelServiceRequest permite cancelar una solicitud
    // "pendiente" (nunca hubo pago) además de "aceptada" — el llamador
    // debe poder distinguir este caso de un fallo real de Stripe.
    mockPrisma.payment.findMany.mockResolvedValue([]);
    await expect(refundPayment('sr-sin-pago')).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });
});

describe('obtenerResumenPagos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lee Pendiente/Disponible del saldo real de Stripe, no de las filas de Payment', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue({
      stripeAccountId: 'acct_1',
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.balance.retrieve.mockResolvedValue({
      pending: [{ currency: 'eur', amount: 4500 }],
      available: [{ currency: 'eur', amount: 12000 }],
    });
    mockPrisma.payment.findMany.mockResolvedValue([]);

    const resumen = await obtenerResumenPagos('prof-1');

    expect(mockStripe.balance.retrieve).toHaveBeenCalledWith({ stripeAccount: 'acct_1' });
    expect(resumen.pendiente).toBe(45);
    expect(resumen.disponible).toBe(120);
    expect(resumen.estadoCuentaStripe).toBe('configurada');
  });

  it('no consulta Stripe y devuelve 0/0 si el profesional todavía no tiene cuenta Connect', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue({
      stripeAccountId: null,
      stripeDetailsSubmitted: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });
    mockPrisma.payment.findMany.mockResolvedValue([]);

    const resumen = await obtenerResumenPagos('prof-1');

    expect(mockStripe.balance.retrieve).not.toHaveBeenCalled();
    expect(resumen.pendiente).toBe(0);
    expect(resumen.disponible).toBe(0);
    expect(resumen.estadoCuentaStripe).toBe('pendiente');
  });

  it('construye el historial solo con pagos liberados, más reciente primero', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue({
      stripeAccountId: 'acct_1',
      stripeDetailsSubmitted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.balance.retrieve.mockResolvedValue({ pending: [], available: [] });
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        id: 'pago-1',
        montoProfesional: 95,
        liberadoAt: new Date('2026-08-01T10:00:00Z'),
        serviceRequest: { categoria: { nombre: 'Fontanería' }, descripcion: 'Fuga en el baño', cliente: { nombre: 'Juan Pérez' } },
      },
    ]);

    const resumen = await obtenerResumenPagos('prof-1');

    expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estado: 'liberado', serviceRequest: { profesionalId: 'prof-1' } },
        orderBy: { liberadoAt: 'desc' },
      })
    );
    expect(resumen.historial).toEqual([
      { id: 'pago-1', monto: 95, fecha: new Date('2026-08-01T10:00:00Z'), categoria: 'Fontanería', descripcion: 'Fuga en el baño', nombreCliente: 'Juan Pérez' },
    ]);
  });

  it('lanza PROFESSIONAL_NOT_FOUND si no existe el profesional', async () => {
    mockPrisma.professional.findUnique.mockResolvedValue(null);
    await expect(obtenerResumenPagos('prof-inexistente')).rejects.toThrow('PROFESSIONAL_NOT_FOUND');
  });
});
