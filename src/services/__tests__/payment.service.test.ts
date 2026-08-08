jest.mock('../../config/prisma', () => ({
  prisma: {
    payment: {
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    serviceRequest: { findUnique: jest.fn() },
    professional: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: { capture: jest.fn(), cancel: jest.fn(), create: jest.fn(), retrieve: jest.fn() },
    transfers: { create: jest.fn(), list: jest.fn() },
    refunds: { create: jest.fn() },
    accounts: { retrieve: jest.fn() },
    balance: { retrieve: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn() },
    ephemeralKeys: { create: jest.fn() },
  },
}));

import Stripe from 'stripe';
import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import {
  releasePayments,
  refundPayment,
  calcularDesglose,
  obtenerResumenPagos,
  obtenerOCrearStripeCustomerId,
  crearEphemeralKey,
  createEscrowPaymentIntent,
  listarPagosAtascados,
  reintentarLiberacion,
} from '../payment.service';

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

describe('obtenerOCrearStripeCustomerId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reutiliza el stripeCustomerId ya guardado si Stripe confirma que existe', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', stripeCustomerId: 'cus_existente' });
    mockStripe.customers.retrieve.mockResolvedValue({ id: 'cus_existente', deleted: false });

    const result = await obtenerOCrearStripeCustomerId('u1');

    expect(result).toBe('cus_existente');
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('crea un Customer nuevo si el guardado ya no existe en Stripe (p.ej. se creó en modo test y ahora corre en live)', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      nombre: 'Ana Sánchez',
      email: 'ana@example.com',
      telefono: null,
      stripeCustomerId: 'cus_de_test',
    });
    mockStripe.customers.retrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ code: 'resource_missing', param: 'customer' })
    );
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_nuevo' });

    const result = await obtenerOCrearStripeCustomerId('u1');

    expect(result).toBe('cus_nuevo');
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { stripeCustomerId: 'cus_nuevo' },
    });
  });

  it('crea el Customer en Stripe y lo persiste si el usuario no tiene uno todavía', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      nombre: 'Ana Sánchez',
      email: 'ana@example.com',
      telefono: null,
      stripeCustomerId: null,
    });
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_nuevo' });

    const result = await obtenerOCrearStripeCustomerId('u1');

    expect(result).toBe('cus_nuevo');
    expect(mockStripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ana Sánchez', email: 'ana@example.com', metadata: { userId: 'u1' } })
    );
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { stripeCustomerId: 'cus_nuevo' },
    });
  });
});

describe('createEscrowPaymentIntent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStripe.ephemeralKeys.create.mockResolvedValue({ secret: 'ek_test_123' });
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_nuevo', client_secret: 'secret_nuevo' });
    mockPrisma.payment.create.mockResolvedValue({ id: 'pago-1', montoBase: 100, montoTotal: 105, comisionPlataforma: 10 });
  });

  it('asocia el Customer y activa setup_future_usage sin tocar capture_method manual', async () => {
    const { customerId, ephemeralKeySecret } = await createEscrowPaymentIntent({
      serviceRequestId: 'sr-1',
      presupuestoId: 'pres-1',
      montoBase: 100,
      clienteStripeCustomerId: 'cus_123',
    });

    expect(mockStripe.ephemeralKeys.create).toHaveBeenCalledWith({ customer: 'cus_123' }, { apiVersion: '2024-04-10' });
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_123',
        setup_future_usage: 'off_session',
        capture_method: 'manual',
        payment_method_types: ['card'],
      }),
      { idempotencyKey: 'intent_pre_pres-1' }
    );
    expect(customerId).toBe('cus_123');
    expect(ephemeralKeySecret).toBe('ek_test_123');
  });

  // Bug real de QA (2026-08-08): la fila nacía como 'retenido' aunque el
  // cliente todavía no había confirmado nada con el Payment Sheet, lo que
  // hacía que la solicitud apareciera como "pagada" sin que Stripe hubiera
  // autorizado un cargo real. Ver comentario del enum EstadoPago.
  it('crea la fila Payment en estado "pendiente", no "retenido" — solo el webhook de Stripe confirma la autorización real', async () => {
    await createEscrowPaymentIntent({
      serviceRequestId: 'sr-1',
      presupuestoId: 'pres-1',
      montoBase: 100,
      clienteStripeCustomerId: 'cus_123',
    });

    expect(mockPrisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ estado: 'pendiente' }),
    });
  });

  it('usa una clave de idempotencia distinta para la autorización de una ampliación', async () => {
    await createEscrowPaymentIntent({
      serviceRequestId: 'sr-1',
      presupuestoId: 'pres-1',
      ampliacionId: 'amp-1',
      montoBase: 50,
      clienteStripeCustomerId: 'cus_123',
    });

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: 'intent_amp_amp-1' }
    );
  });

  it('adopta la fila existente si el insert choca por PaymentIntent ya registrado (doble tap concurrente)', async () => {
    mockPrisma.payment.create.mockRejectedValue({ code: 'P2002' });
    mockPrisma.payment.findUniqueOrThrow.mockResolvedValue({ id: 'pago-existente', montoBase: 100 });

    const { pago } = await createEscrowPaymentIntent({
      serviceRequestId: 'sr-1',
      presupuestoId: 'pres-1',
      montoBase: 100,
      clienteStripeCustomerId: 'cus_123',
    });

    expect(mockPrisma.payment.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_nuevo' },
    });
    expect(pago).toEqual({ id: 'pago-existente', montoBase: 100 });
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
    // El lease de liberación se toma con un updateMany condicional: por
    // defecto se concede (count > 0). Los tests de concurrencia lo
    // sobreescriben a 0 para simular "otra ejecución está dentro".
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.payment.count.mockResolvedValue(0);
  });

  // Por defecto representa una autorización con base=100 (cliente 105,
  // profesional 95) todavía sin capturar y sin intentos previos.
  const pagoRetenido = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    estado: 'retenido',
    stripePaymentIntentId: 'pi_123',
    stripeTransferId: null,
    stripeChargeId: null,
    capturadoAt: null,
    capturadoBase: null,
    capturadoTotal: null,
    capturadoProfesional: null,
    intentosLiberacion: 1,
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
      expect.objectContaining({ source_transaction: 'ch_456' }),
      { idempotencyKey: 'trf_pago-1' }
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
      expect.objectContaining({ source_transaction: 'ch_999' }),
      { idempotencyKey: 'trf_pago-1' }
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
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith('pi_123', undefined, {
      idempotencyKey: 'cap_pago-1',
    });
    // Se transfiere el montoProfesional YA FIJADO en la autorización (95€), no recalculado.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, destination: 'acct_pro_1' }),
      { idempotencyKey: 'trf_pago-1' }
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
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_123',
      { amount_to_capture: 7875 },
      { idempotencyKey: 'cap_pago-1' }
    );
    // 75% de los 95€ que iba a recibir el profesional = 71.25€ — proporción fijada en la autorización, no recalculada con el % vigente.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7125 }),
      { idempotencyKey: 'trf_pago-1' }
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

    expect(mockStripe.paymentIntents.capture).toHaveBeenNthCalledWith(1, 'pi_inicial', undefined, {
      idempotencyKey: 'cap_pago-1',
    });
    // 40% de los 52.5€ autorizados en la ampliación = 21€.
    expect(mockStripe.paymentIntents.capture).toHaveBeenNthCalledWith(
      2,
      'pi_ampliacion',
      { amount_to_capture: 2100 },
      { idempotencyKey: 'cap_pago-2' }
    );
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
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_inicial',
      { amount_to_capture: 9450 },
      { idempotencyKey: 'cap_pago-1' }
    );
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_ampliacion', undefined, {
      idempotencyKey: 'cnl_pago-2',
    });
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

/**
 * AUDITORÍA B2 (2026-08-04) — liberación idempotente y reanudable.
 *
 * El bloque de arriba cubre el camino feliz. Este cubre justamente lo
 * que antes NO se podía hacer: reanudar una liberación que se quedó a
 * medias entre la captura (① el dinero sale del cliente) y la
 * transferencia (② el dinero llega al profesional), sin duplicar ningún
 * movimiento de dinero.
 */
describe('releasePayments — recuperación e idempotencia', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.payment.count.mockResolvedValue(0);
    mockPrisma.payment.update.mockImplementation(({ data }: any) => Promise.resolve({ ...data }));
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_nuevo' });
    mockStripe.transfers.list.mockResolvedValue({ data: [] });
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      profesional: { userId: 'prof-1', stripeAccountId: 'acct_pro_1' },
    });
  });

  const base = {
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    stripePaymentIntentId: 'pi_123',
    stripeTransferId: null,
    stripeChargeId: null,
    capturadoAt: null,
    capturadoBase: null,
    capturadoTotal: null,
    capturadoProfesional: null,
    intentosLiberacion: 1,
    montoBase: 100,
    montoTotal: 105,
    montoProfesional: 95,
  };

  it('congela el plan en BD ANTES de llamar a Stripe (write-ahead)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_1' });

    await releasePayments('sr-1', 75);

    // El plan (75% de la autorización) se persiste antes de capturar: si
    // el proceso muere en la captura, el reintento sabe con qué importes
    // se hizo, en vez de tener que adivinarlos.
    const escrituraDelPlan = mockPrisma.payment.update.mock.calls.find(
      ([arg]: any) => arg.data.capturadoBase !== undefined
    );
    expect(escrituraDelPlan[0].data).toEqual({
      capturadoBase: 75,
      capturadoTotal: 78.75,
      capturadoProfesional: 71.25,
    });
    const ordenPlan = mockPrisma.payment.update.mock.invocationCallOrder[0];
    const ordenCaptura = mockStripe.paymentIntents.capture.mock.invocationCallOrder[0];
    expect(ordenPlan).toBeLessThan(ordenCaptura);
  });

  /**
   * EL escenario que antes perdía el dinero: Render se reinició (o
   * Stripe dio timeout) justo después de capturar y antes de
   * transferir. La fila quedó en 'capturado'.
   */
  it('reanuda desde una fila ya capturada: NO vuelve a capturar, solo transfiere', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        ...base,
        estado: 'capturado',
        capturadoAt: new Date(),
        stripeChargeId: 'ch_previo',
        capturadoBase: 100,
        capturadoTotal: 105,
        capturadoProfesional: 95,
        intentosLiberacion: 2,
      },
    ]);

    await releasePayments('sr-1', 100);

    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, source_transaction: 'ch_previo', transfer_group: 'pago-1' }),
      { idempotencyKey: 'trf_pago-1' }
    );
  });

  /**
   * Variante más peligrosa: el proceso murió DESPUÉS de que Stripe
   * capturase pero ANTES de escribirlo aquí. La fila sigue en
   * 'retenido' aunque el cliente ya haya pagado. Antes, el pre-chequeo
   * veía 'succeeded' != 'requires_capture' y lanzaba
   * PAGO_NO_AUTORIZADO_TODAVIA para siempre — el dinero quedaba
   * atrapado sin ninguna vía de recuperación.
   */
  it('adopta una captura huérfana (succeeded en Stripe, retenido en BD) en vez de darla por no autorizada', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      status: 'succeeded',
      amount_received: 10500,
      latest_charge: 'ch_huerfano',
    });

    await releasePayments('sr-1', 100);

    // No se re-captura (Stripe lo rechazaría) y la transferencia sale igual.
    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, source_transaction: 'ch_huerfano' }),
      { idempotencyKey: 'trf_pago-1' }
    );
  });

  it('reconstruye la proporción correcta al adoptar una captura huérfana PARCIAL', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    // Se capturaron 78.75€ de los 105€ autorizados = 75%.
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      status: 'succeeded',
      amount_received: 7875,
      latest_charge: 'ch_parcial',
    });

    await releasePayments('sr-1', 100);

    // 75% de los 95€ del profesional = 71.25€. Reconstruido de la
    // proporción real, no recalculado con los % de comisión vigentes.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7125 }),
      { idempotencyKey: 'trf_pago-1' }
    );
  });

  /**
   * Red de seguridad para cuando la clave de idempotencia de Stripe ya
   * caducó (24 h): un intento anterior llegó a crear la transferencia
   * pero murió antes de guardarla. Sin esta comprobación, el reintento
   * pagaría DOS VECES al profesional.
   */
  it('NO crea una segunda transferencia si ya existe una con el mismo transfer_group', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        ...base,
        estado: 'capturado',
        capturadoAt: new Date(),
        stripeChargeId: 'ch_previo',
        capturadoBase: 100,
        capturadoTotal: 105,
        capturadoProfesional: 95,
        intentosLiberacion: 3,
      },
    ]);
    mockStripe.transfers.list.mockResolvedValue({ data: [{ id: 'tr_ya_existente' }] });

    await releasePayments('sr-1', 100);

    expect(mockStripe.transfers.list).toHaveBeenCalledWith({ transfer_group: 'pago-1', limit: 1 });
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    // Se adopta la transferencia previa en lugar de crear una nueva.
    const escrituraFinal = mockPrisma.payment.update.mock.calls.find(
      ([arg]: any) => arg.data.estado === 'liberado'
    );
    expect(escrituraFinal[0].data.stripeTransferId).toBe('tr_ya_existente');
  });

  it('no consulta transfer_group en el primer intento (sin llamadas extra a Stripe en el camino feliz)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido', intentosLiberacion: 1 }]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_1' });

    await releasePayments('sr-1', 100);

    expect(mockStripe.transfers.list).not.toHaveBeenCalled();
  });

  it('adopta la captura previa si la clave de idempotencia caducó y Stripe responde payment_intent_unexpected_state', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve
      .mockResolvedValueOnce({ status: 'requires_capture' }) // planificación
      .mockResolvedValueOnce({ status: 'succeeded', latest_charge: 'ch_recuperado' }); // relectura tras el error
    const errorStripe: Error & { code?: string } = new Error('Ya capturado');
    errorStripe.code = 'payment_intent_unexpected_state';
    mockStripe.paymentIntents.capture.mockRejectedValue(errorStripe);

    await releasePayments('sr-1', 100);

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_transaction: 'ch_recuperado' }),
      { idempotencyKey: 'trf_pago-1' }
    );
  });

  it('propaga el error de captura si el PaymentIntent NO estaba realmente capturado', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve
      .mockResolvedValueOnce({ status: 'requires_capture' })
      .mockResolvedValueOnce({ status: 'canceled' });
    const errorStripe: Error & { code?: string } = new Error('Estado inesperado');
    errorStripe.code = 'payment_intent_unexpected_state';
    mockStripe.paymentIntents.capture.mockRejectedValue(errorStripe);

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('Estado inesperado');
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });

  it('rechaza una ejecución concurrente con LIBERACION_YA_EN_CURSO en vez de duplicar movimientos', async () => {
    // El updateMany condicional del lease no afectó a ninguna fila: otra
    // ejecución lo tiene tomado ahora mismo.
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.count.mockResolvedValue(1);

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('LIBERACION_YA_EN_CURSO');
    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });

  it('distingue "no hay nada que liberar" de "hay otra ejecución dentro"', async () => {
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.count.mockResolvedValue(0);

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('registra el motivo del fallo y suelta el lease para que el reintento pueda entrar', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    mockStripe.paymentIntents.capture.mockRejectedValue(new Error('Stripe timeout'));

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('Stripe timeout');

    const registroDelError = mockPrisma.payment.updateMany.mock.calls.find(
      ([arg]: any) => arg.data.ultimoErrorLiberacion !== undefined
    );
    expect(registroDelError[0].data.ultimoErrorLiberacion).toBe('Stripe timeout');

    // El lease se suelta pase lo que pase (finally): si no, el pago
    // quedaría bloqueado 5 minutos tras cada fallo.
    const sueltaDelLease = mockPrisma.payment.updateMany.mock.calls.find(
      ([arg]: any) => arg.data.liberacionEnCursoAt === null
    );
    expect(sueltaDelLease).toBeDefined();
  });

  it('mezcla correctamente una fila ya capturada con otra todavía retenida, sin recontar la base', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        ...base,
        id: 'pago-1',
        estado: 'capturado',
        stripePaymentIntentId: 'pi_inicial',
        stripeChargeId: 'ch_previo',
        capturadoBase: 100,
        capturadoTotal: 105,
        capturadoProfesional: 95,
        intentosLiberacion: 2,
      },
      {
        ...base,
        id: 'pago-2',
        estado: 'retenido',
        ampliacionId: 'ampl-1',
        stripePaymentIntentId: 'pi_ampliacion',
        montoBase: 50,
        montoTotal: 52.5,
        montoProfesional: 47.5,
        intentosLiberacion: 2,
      },
    ]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_ampliacion', latest_charge: 'ch_2' });

    // Base final 120 = los 100 ya capturados + 20 de los 50 de la ampliación.
    await releasePayments('sr-1', 120);

    // La fila capturada no se re-captura...
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    // ...y la ampliación se planifica solo contra los 20 que quedan (40%).
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_ampliacion',
      { amount_to_capture: 2100 },
      { idempotencyKey: 'cap_pago-2' }
    );
  });
});

describe('refundPayment — filas ya capturadas', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.update.mockResolvedValue({ estado: 'reembolsado' });
  });

  /**
   * Antes, refundPayment solo miraba 'retenido'. Una disputa a favor del
   * cliente sobre un pago a medio liberar (ya capturado) lanzaba
   * PAGO_NO_ENCONTRADO y la disputa no se podía cerrar nunca.
   */
  it('reembolsa el cargo (no cancela) cuando el dinero ya salió de la tarjeta', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', estado: 'capturado', stripePaymentIntentId: 'pi_1' },
    ]);
    mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });

    await refundPayment('sr-1');

    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_1' }),
      { idempotencyKey: 'ref_pago-1' }
    );
  });
});

describe('listarPagosAtascados', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marca como dinero retenido en plataforma solo las filas capturadas sin transferir', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        id: 'pago-1',
        serviceRequestId: 'sr-1',
        estado: 'capturado',
        montoProfesional: 95,
        capturadoProfesional: 95,
        capturadoAt: new Date('2026-08-04T09:00:00Z'),
        createdAt: new Date('2026-08-03T09:00:00Z'),
        intentosLiberacion: 2,
        ultimoErrorLiberacion: 'Stripe timeout',
        serviceRequest: {
          estado: 'completada',
          categoria: { nombre: 'Aire acondicionado' },
          cliente: { nombre: 'Ana Sánchez' },
          profesional: { user: { nombre: 'José Fernández' } },
        },
      },
      {
        id: 'pago-2',
        serviceRequestId: 'sr-2',
        estado: 'retenido',
        montoProfesional: 40,
        capturadoProfesional: null,
        capturadoAt: null,
        createdAt: new Date('2026-08-03T10:00:00Z'),
        intentosLiberacion: 1,
        ultimoErrorLiberacion: null,
        serviceRequest: {
          estado: 'completada',
          categoria: { nombre: 'Fontanería' },
          cliente: { nombre: 'Luis Pérez' },
          profesional: null,
        },
      },
    ]);

    const atascados = await listarPagosAtascados();

    expect(atascados[0].dineroRetenidoEnPlataforma).toBe(true);
    expect(atascados[0].ultimoError).toBe('Stripe timeout');
    expect(atascados[0].categoria).toBe('Aire acondicionado');
    expect(atascados[0].clienteNombre).toBe('Ana Sánchez');
    expect(atascados[0].profesionalNombre).toBe('José Fernández');
    expect(atascados[1].dineroRetenidoEnPlataforma).toBe(false);
    // profesional puede venir null (ver interfaz PagoAtascado) — no debe reventar.
    expect(atascados[1].profesionalNombre).toBeNull();
  });
});

describe('reintentarLiberacion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.count.mockResolvedValue(0);
  });

  it('usa el precioFinal ya fijado al completar el trabajo', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ precioFinal: 120 });

    // Sin filas liberables, releasePayments sale con PAGO_NO_ENCONTRADO:
    // lo que se comprueba aquí es de dónde saca la base, no la liberación.
    await expect(reintentarLiberacion('sr-1')).rejects.toThrow('PAGO_NO_ENCONTRADO');
    expect(mockPrisma.serviceRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sr-1' } })
    );
  });

  it('lanza SOLICITUD_NO_ENCONTRADA si la solicitud no existe', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
    await expect(reintentarLiberacion('sr-fantasma')).rejects.toThrow('SOLICITUD_NO_ENCONTRADA');
  });

  it('recompone la base sumando las autorizaciones pendientes si no hay precioFinal (caso disputa)', async () => {
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({ precioFinal: null });
    mockPrisma.payment.findMany.mockResolvedValue([
      { montoBase: 100, capturadoBase: null },
      { montoBase: 50, capturadoBase: 20 }, // ya capturada: cuenta su base congelada
    ]);

    await expect(reintentarLiberacion('sr-1')).rejects.toThrow('PAGO_NO_ENCONTRADO');
    expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceRequestId: 'sr-1', estado: { in: ['retenido', 'capturado'] } },
      })
    );
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

    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', undefined, {
      idempotencyKey: 'cnl_pago-1',
    });
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_2', undefined, {
      idempotencyKey: 'cnl_pago-2',
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pago-1' },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pago-2' },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
  });

  it('lanza PAGO_NO_ENCONTRADO si la solicitud nunca llegó a tener un pago autorizado', async () => {
    // Caso real: cancelServiceRequest permite cancelar una solicitud
    // "pendiente" (nunca hubo pago) además de "aceptada" — el llamador
    // debe poder distinguir este caso de un fallo real de Stripe.
    mockPrisma.payment.findMany.mockResolvedValue([]);
    await expect(refundPayment('sr-sin-pago')).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('reembolsa (sin reverse_transfer) un pago "capturado" que nunca llegó a transferirse', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', estado: 'capturado', stripePaymentIntentId: 'pi_1' },
    ]);
    mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });

    await refundPayment('sr-1');

    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', metadata: { paymentId: 'pago-1', serviceRequestId: 'sr-1' } },
      { idempotencyKey: 'ref_pago-1' }
    );
  });

  // Hallazgo #4 de la auditoría: antes 'liberado' quedaba fuera de
  // refundPayment por completo, así que una disputa a favor del cliente
  // sobre un trabajo ya completado no tenía forma de resolverse.
  it('reembolsa CON reverse_transfer un pago ya "liberado" al profesional (disputa tras completar)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', estado: 'liberado', stripePaymentIntentId: 'pi_1' },
    ]);
    mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });

    await refundPayment('sr-1');

    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_1',
        reverse_transfer: true,
        metadata: { paymentId: 'pago-1', serviceRequestId: 'sr-1' },
      },
      { idempotencyKey: 'ref_pago-1' }
    );
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pago-1' },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
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
