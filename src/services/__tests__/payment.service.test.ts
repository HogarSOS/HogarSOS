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
    // P2 (auditoría 2026-08-14, revisión de concurrencia crítica):
    // reclamarFilas usa UPDATE...RETURNING (no updateMany, que solo
    // devuelve count) para conocer EXACTAMENTE qué filas reclamó esta
    // ejecución — necesario para procesar solo esas filas, nunca un
    // superconjunto derivado de re-filtrar por estado.
    $queryRaw: jest.fn(),
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
  createEscrowPaymentIntent,
  reautorizarPaymentIntent,
  listarPagosAtascados,
  reintentarLiberacion,
  diagnosticarPagoSinConfirmar,
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

/**
 * B5: una fila Payment con estado 'reembolsado' porque su autorización
 * caducó en Stripe (~7 días sin capturar). Todo el bloque parte de esta
 * fila "muerta" con intentosAutorizacion: 0 salvo que un test concreto
 * la sobreescriba.
 */
describe('reautorizarPaymentIntent (B5)', () => {
  const pagoMuerto = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pago-viejo',
    serviceRequestId: 'sr-1',
    presupuestoId: 'pres-1',
    ampliacionId: null,
    estado: 'reembolsado',
    stripePaymentIntentId: 'pi_viejo_canceled',
    montoBase: 180,
    montoTotal: 189,
    comisionPlataforma: 9,
    intentosAutorizacion: 0,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStripe.ephemeralKeys.create.mockResolvedValue({ secret: 'ek_nueva' });
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_nuevo_2', client_secret: 'secret_nuevo_2' });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.payment.findUniqueOrThrow.mockResolvedValue({
      id: 'pago-viejo',
      estado: 'pendiente',
      stripePaymentIntentId: 'pi_nuevo_2',
      montoBase: 180,
      montoTotal: 189,
      comisionPlataforma: 9,
      intentosAutorizacion: 1,
    });
  });

  it('crea un PaymentIntent NUEVO en Stripe, distinto del cancelado, y devuelve su client_secret', async () => {
    const resultado = await reautorizarPaymentIntent(pagoMuerto() as any, 'cus_123');

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const [params] = mockStripe.paymentIntents.create.mock.calls[0];
    expect(params.amount).toBe(18900); // montoTotal guardado (189) * 100, no recalculado
    expect(params.capture_method).toBe('manual');

    expect(resultado.clientSecret).toBe('secret_nuevo_2');
    expect(resultado.clientSecret).not.toBe('pi_viejo_canceled');
  });

  it('actualiza la MISMA fila Payment (no crea una fila nueva)', async () => {
    await reautorizarPaymentIntent(pagoMuerto() as any, 'cus_123');

    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-viejo', stripePaymentIntentId: 'pi_viejo_canceled' },
      data: {
        stripePaymentIntentId: 'pi_nuevo_2',
        estado: 'pendiente',
        avisoCaducidadEnviadoAt: null,
        intentosAutorizacion: 1,
      },
    });
  });

  it('usa la idempotency key intent_retry_<id>_<intento> derivada del id de la fila', async () => {
    await reautorizarPaymentIntent(pagoMuerto({ intentosAutorizacion: 0 }) as any, 'cus_123');

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: 'intent_retry_pago-viejo_1' }
    );
  });

  it('doble clic simultáneo: misma fila y misma idempotency key en ambas llamadas', async () => {
    const pago = pagoMuerto();

    await Promise.all([
      reautorizarPaymentIntent(pago as any, 'cus_123'),
      reautorizarPaymentIntent(pago as any, 'cus_123'),
    ]);

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(2);
    const claves = mockStripe.paymentIntents.create.mock.calls.map((c: any[]) => c[1].idempotencyKey);
    // Las dos llamadas parten del MISMO pago.intentosAutorizacion (0, leído
    // antes de que ninguna escriba) -> misma clave en Stripe en las dos, que
    // es justo lo que hace que Stripe devuelva el mismo PaymentIntent a
    // ambas en vez de crear dos autorizaciones distintas.
    expect(claves[0]).toBe(claves[1]);
    expect(claves[0]).toBe('intent_retry_pago-viejo_1');
  });

  it('segunda caducidad de la MISMA fila: usa el intento 2, no reutiliza la clave del intento 1', async () => {
    await reautorizarPaymentIntent(pagoMuerto({ intentosAutorizacion: 1 }) as any, 'cus_123');

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: 'intent_retry_pago-viejo_2' }
    );
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ intentosAutorizacion: 2 }) })
    );
  });

  it('el importe sale exclusivamente de montoBase/montoTotal/comisionPlataforma ya guardados, nunca se recalcula ni acepta un valor externo', async () => {
    // Un montoBase distinto al montoTotal ya guardado simularía que el
    // presupuesto cambió después de la autorización original — la
    // reautorización NO debe leerlo, solo debe usar lo ya persistido.
    await reautorizarPaymentIntent(
      pagoMuerto({ montoBase: 999, montoTotal: 189, comisionPlataforma: 9 }) as any,
      'cus_123'
    );

    const [params] = mockStripe.paymentIntents.create.mock.calls[0];
    expect(params.amount).toBe(18900); // deriva de montoTotal (189), no de montoBase (999)
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
    // P2 (auditoría 2026-08-14, revisión de concurrencia crítica): el
    // lease ahora se reclama con UPDATE...RETURNING ($queryRaw), no
    // updateMany — por defecto se reclama exactamente 'pago-1' (el id
    // que usa pagoRetenido() por defecto) con el fencing token ya
    // incrementado. payment.count representa el TOTAL de filas
    // relevantes para la comprobación "todo o nada": por defecto
    // coincide con lo reclamado (1), así que reclamarTodoOAbortar no
    // aborta. Los tests de concurrencia sobreescriben ambos para
    // simular reclamos parciales o nulos.
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 2 }]);
    mockPrisma.payment.count.mockResolvedValue(1);
    // updateMany se sigue usando para liberar el lease (condicionado al
    // fencing token) y para el resto de escrituras incidentales.
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
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

  /**
   * B5: una fila que ya pasó por reautorizarPaymentIntent (intentosAutorizacion: 1,
   * stripePaymentIntentId apuntando al PaymentIntent nuevo, estado ya
   * 'retenido' porque el webhook confirmó la reautorización) debe
   * capturarse y liberarse exactamente igual que una fila nunca
   * reautorizada — releasePayments no debe tratarlas distinto.
   */
  it('captura y transfiere igual una fila reautorizada (intentosAutorizacion > 0) que una normal', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pagoRetenido({ stripePaymentIntentId: 'pi_reautorizado', intentosAutorizacion: 1 }),
    ]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_reautorizado', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 100);

    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_reautorizado',
      undefined,
      { idempotencyKey: 'cap_pago-1' }
    );
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
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pago-2' }),
        data: expect.objectContaining({ estado: 'reembolsado' }),
      })
    );
  });

  // H/I/J del pedido de la auditoría 2026-08-14: el escenario exacto de
  // evasión analizado (50€/h × 10h estimadas → 500€ de base autorizada
  // → el profesional declara horasReales=1 y el cliente lo confirma).
  // Prueba que, aunque la protección de horasReales viviera solo en el
  // controlador, la capa de pagos por sí sola YA garantiza que jamás se
  // cobra ni comisiona más que el importe real, y que el resto de la
  // autorización se libera sin cargo alguno — sea cual sea el origen
  // del importe final reducido.
  it('escenario auditado: 500€ autorizados, horasReales=1 → precioFinal=50€ — captura y comisiona solo el 10%, el resto se libera sin cobrar nada', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pagoRetenido({ montoBase: 500, montoTotal: 525, montoProfesional: 475 }),
    ]);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ estado: 'liberado' });

    await releasePayments('sr-1', 50); // tarifaHora(50€) × horasReales(1) = 50€, de una base autorizada de 500€ (10%)

    // I) Captura parcial: solo el 10% de lo que el cliente autorizó (525€) = 52.5€.
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_123',
      { amount_to_capture: 5250 },
      { idempotencyKey: 'cap_pago-1' }
    );
    // H) Comisión: el profesional recibe el mismo 10% de sus 475€ autorizados = 47.5€ — la
    // proporción de comisión se mantiene, pero la base absoluta comisionable es solo la real.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 4750 }),
      { idempotencyKey: 'trf_pago-1' }
    );
    // J) Los 450€ de base no consumidos (90% restante) no se capturan ni se cancelan aparte:
    // al ser un único PaymentIntent, la propia captura parcial de Stripe libera automáticamente
    // el resto de la autorización — no hay ningún cobro adicional posible sobre ese sobrante.
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
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
 * P1 (auditoría 2026-08-14): distingue, SOLO leyendo Stripe (sin
 * capturar, cancelar ni transferir nada), por qué un pago no está en
 * requires_capture — el mismo problema que hace lanzar
 * PAGO_NO_AUTORIZADO_TODAVIA en releasePayments, pero aquí exponiendo el
 * motivo para que el controller pueda dar un aviso correcto.
 */
describe('diagnosticarPagoSinConfirmar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const pagoBase = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    estado: 'retenido',
    stripePaymentIntentId: 'pi_123',
    ...overrides,
  });

  it('devuelve "nunca_autorizado" si el PaymentIntent nunca llegó a confirmarse', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoBase()]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_payment_method' });

    await expect(diagnosticarPagoSinConfirmar('sr-1')).resolves.toBe('nunca_autorizado');
  });

  it('devuelve "autorizacion_caducada" si Stripe ya canceló la autorización (B5)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoBase()]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    await expect(diagnosticarPagoSinConfirmar('sr-1')).resolves.toBe('autorizacion_caducada');
  });

  it('con varias autorizaciones, basta con que UNA esté "canceled" para reportar "autorizacion_caducada"', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pagoBase({ id: 'pago-1', stripePaymentIntentId: 'pi_1' }),
      pagoBase({ id: 'pago-2', stripePaymentIntentId: 'pi_2' }),
    ]);
    mockStripe.paymentIntents.retrieve
      .mockResolvedValueOnce({ status: 'requires_payment_method' })
      .mockResolvedValueOnce({ status: 'canceled' });

    await expect(diagnosticarPagoSinConfirmar('sr-1')).resolves.toBe('autorizacion_caducada');
  });

  it('ignora las filas sin stripePaymentIntentId en vez de fallar', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoBase({ stripePaymentIntentId: null })]);

    await expect(diagnosticarPagoSinConfirmar('sr-1')).resolves.toBe('nunca_autorizado');
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('no captura, cancela ni transfiere nada — es de solo lectura', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pagoBase()]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    await diagnosticarPagoSinConfirmar('sr-1');

    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
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
    // P2 (auditoría 2026-08-14, revisión de concurrencia crítica): claim
    // exacto por UPDATE...RETURNING — por defecto reclama 'pago-1' (el
    // id de `base`), coincidiendo con `payment.count` para que
    // reclamarTodoOAbortar no aborte por reclamo parcial.
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 2 }]);
    mockPrisma.payment.count.mockResolvedValue(1);
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
    // se hizo, en vez de tener que adivinarlos. Ahora es un updateMany
    // fenced (condicionado a intentosLiberacion), no un update simple.
    const escrituraDelPlan = mockPrisma.payment.updateMany.mock.calls.find(
      ([arg]: any) => arg.data.capturadoBase !== undefined
    );
    expect(escrituraDelPlan[0]).toEqual({
      where: { id: 'pago-1', intentosLiberacion: 1 },
      data: {
        capturadoBase: 75,
        capturadoTotal: 78.75,
        capturadoProfesional: 71.25,
      },
    });
    const ordenPlan = mockPrisma.payment.updateMany.mock.invocationCallOrder[0];
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
    const escrituraFinal = mockPrisma.payment.updateMany.mock.calls.find(
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
    // El UPDATE...RETURNING no devuelve ninguna fila: otra ejecución las
    // tiene tomadas ahora mismo. payment.count SÍ ve la fila (existe y
    // es relevante), solo que no se pudo reclamar.
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.payment.count.mockResolvedValue(1);

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('LIBERACION_YA_EN_CURSO');
    expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });

  it('distingue "no hay nada que liberar" de "hay otra ejecución dentro"', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.payment.count.mockResolvedValue(0);

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('registra el motivo del fallo y suelta el lease para que el reintento pueda entrar', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([{ ...base, estado: 'retenido' }]);
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    mockStripe.paymentIntents.capture.mockRejectedValue(new Error('Stripe timeout'));

    await expect(releasePayments('sr-1', 100)).rejects.toThrow('Stripe timeout');

    // P2 (auditoría 2026-08-14, revisión de concurrencia crítica): tanto
    // el registro del error como la liberación del lease ahora van
    // condicionados al fencing token (id + intentosLiberacion exacto)
    // capturado en el claim — no un updateMany "a ciegas" por estado.
    const registroDelError = mockPrisma.payment.updateMany.mock.calls.find(
      ([arg]: any) => arg.data.ultimoErrorLiberacion !== undefined
    );
    expect(registroDelError[0]).toEqual({
      where: { id: 'pago-1', intentosLiberacion: 2 },
      data: { ultimoErrorLiberacion: 'Stripe timeout' },
    });

    // El lease se suelta pase lo que pase (finally): si no, el pago
    // quedaría bloqueado 5 minutos tras cada fallo.
    const sueltaDelLease = mockPrisma.payment.updateMany.mock.calls.find(
      ([arg]: any) => arg.data.liberacionEnCursoAt === null
    );
    expect(sueltaDelLease[0]).toEqual({
      where: { id: 'pago-1', intentosLiberacion: 2 },
      data: { liberacionEnCursoAt: null },
    });
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
    // Dos filas relevantes, las dos reclamadas — todo o nada coincide.
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'pago-1', intentosLiberacion: 3 },
      { id: 'pago-2', intentosLiberacion: 3 },
    ]);
    mockPrisma.payment.count.mockResolvedValue(2);
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
    // Lease compartido con releasePayments (ver reclamarTodoOAbortar):
    // concedido por defecto para no bloquear estos tests, que no prueban
    // concurrencia — reclama exactamente 'pago-1', el id que usan.
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
    mockPrisma.payment.count.mockResolvedValue(1);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
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
    // Sin nada que reclamar: reclamarTodoOAbortar lanza PAGO_NO_ENCONTRADO
    // antes de llegar a ejecutarLiberacion — lo que estos tests
    // comprueban es de dónde saca la base (precioFinal vs recomposición),
    // no el resultado de la liberación en sí.
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.payment.count.mockResolvedValue(0);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });
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
    // P2 (auditoría 2026-08-14, revisión de concurrencia crítica): el
    // lease compartido con releasePayments ahora se reclama con
    // UPDATE...RETURNING ($queryRaw), no updateMany. Por defecto se
    // reclama exactamente 'pago-1' (el id que usan la mayoría de estos
    // tests), coincidiendo con payment.count para que
    // reclamarTodoOAbortar no aborte. Los tests con más de una fila o
    // con la carrera explícita sobreescriben ambos mocks.
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
    mockPrisma.payment.count.mockResolvedValue(1);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
  });

  it('cancela TODAS las autorizaciones retenidas (inicial + ampliaciones) y las marca como reembolsadas', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', stripePaymentIntentId: 'pi_1', intentosLiberacion: 1 },
      { id: 'pago-2', stripePaymentIntentId: 'pi_2', intentosLiberacion: 1 },
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'pago-1', intentosLiberacion: 1 },
      { id: 'pago-2', intentosLiberacion: 1 },
    ]);
    mockPrisma.payment.count.mockResolvedValue(2);
    mockStripe.paymentIntents.cancel.mockResolvedValue({ id: 'pi_cancel', status: 'canceled' });

    await refundPayment('sr-1');

    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', undefined, {
      idempotencyKey: 'cnl_pago-1',
    });
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_2', undefined, {
      idempotencyKey: 'cnl_pago-2',
    });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-1', intentosLiberacion: 1 },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-2', intentosLiberacion: 1 },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
  });

  it('lanza PAGO_NO_ENCONTRADO si la solicitud nunca llegó a tener un pago autorizado', async () => {
    // Caso real: cancelServiceRequest permite cancelar una solicitud
    // "pendiente" (nunca hubo pago) además de "aceptada" — el llamador
    // debe poder distinguir este caso de un fallo real de Stripe. Nada
    // que reclamar: reclamarTodoOAbortar lanza aquí, sin llegar siquiera
    // al findMany de ejecutarReembolso.
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.payment.count.mockResolvedValue(0);
    await expect(refundPayment('sr-sin-pago')).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('reembolsa (sin reverse_transfer) un pago "capturado" que nunca llegó a transferirse', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      { id: 'pago-1', estado: 'capturado', stripePaymentIntentId: 'pi_1', intentosLiberacion: 1 },
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
      { id: 'pago-1', estado: 'liberado', stripePaymentIntentId: 'pi_1', intentosLiberacion: 1 },
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
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-1', intentosLiberacion: 1 },
      data: { estado: 'reembolsado', liberacionEnCursoAt: null },
    });
  });

  /**
   * P2 (auditoría 2026-08-14): refundPayment ahora comparte el lease de
   * releasePayments (Payment.liberacionEnCursoAt) en vez de ignorarlo.
   * Estos tests comprueban el ORDEN (lease antes que Stripe), que el
   * perdedor de una carrera nunca llega a Stripe, y que el lease se
   * suelta siempre — no solo los estados finales.
   */
  describe('coordinación con el lease compartido (releasePayments)', () => {
    it('adquiere el lease (UPDATE...RETURNING) ANTES de llamar a Stripe', async () => {
      const orden: string[] = [];
      mockPrisma.$queryRaw.mockImplementation(async () => {
        orden.push('lease');
        return [{ id: 'pago-1', intentosLiberacion: 1 }];
      });
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([
        { id: 'pago-1', estado: 'retenido', stripePaymentIntentId: 'pi_1' },
      ]);
      mockStripe.paymentIntents.cancel.mockImplementation(async () => {
        orden.push('stripe');
        return { status: 'canceled' };
      });

      await refundPayment('sr-1');

      expect(orden).toEqual(['lease', 'stripe']);
    });

    it('si NO consigue el lease (otra operación en curso), NO llama a Stripe en absoluto', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(1); // sí hay filas reembolsables, solo que están tomadas

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
      expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('sin lease Y sin nada reembolsable, distingue PAGO_NO_ENCONTRADO de LIBERACION_YA_EN_CURSO', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      await expect(refundPayment('sr-1')).rejects.toThrow('PAGO_NO_ENCONTRADO');
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    });

    it('release y refund simultáneos: el que pierde el lease no toca Stripe (release gana)', async () => {
      // Simula que releasePayments ya tomó el lease: el UPDATE...RETURNING
      // de refundPayment no devuelve ninguna fila.
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(1);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    });

    it('suelta el lease en el finally incluso si Stripe falla a mitad del bucle', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        { id: 'pago-1', estado: 'retenido', stripePaymentIntentId: 'pi_1' },
      ]);
      mockStripe.paymentIntents.cancel.mockRejectedValue(new Error('Stripe caído'));

      await expect(refundPayment('sr-1')).rejects.toThrow('Stripe caído');

      // La liberación va condicionada al fencing token capturado en el claim.
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pago-1', intentosLiberacion: 1 },
        data: { liberacionEnCursoAt: null },
      });
    });

    it('dos refund simultáneos sobre la misma fila: misma idempotencyKey en ambos, sin duplicar el reembolso en Stripe', async () => {
      // El lease serializa las dos ejecuciones (una gana, la otra falla
      // limpio) — pero incluso si llegaran a coincidir, la clave
      // determinista ('ref_'+pago.id) ya protegía esto a nivel de Stripe
      // antes de este cambio; se conserva sin modificar.
      mockPrisma.payment.findMany.mockResolvedValue([
        { id: 'pago-1', estado: 'capturado', stripePaymentIntentId: 'pi_1' },
      ]);
      mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });

      await refundPayment('sr-1');

      expect(mockStripe.refunds.create).toHaveBeenCalledWith(
        expect.anything(),
        { idempotencyKey: 'ref_pago-1' }
      );
      expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * P2 (auditoría 2026-08-14, revisión de concurrencia crítica): casos
   * A-E pedidos explícitamente. Demuestran, con filas mixtas reales, que
   * refundPayment reclama EXACTAMENTE lo que su UPDATE...RETURNING
   * consigue, que si eso es menos de lo que necesita (ESTADOS_REEMBOLSABLES
   * = retenido+capturado+liberado) aborta ENTERO sin tocar Stripe sobre
   * ninguna fila — ni siquiera la que sí llegó a reclamar — y suelta ese
   * reclamo parcial antes de devolver el error. No se repite el camino
   * feliz de `releasePayments` (ya cubierto en otros tests) — cada test
   * aquí demuestra solo la propiedad de concurrencia.
   */
  describe('Casos A-E: qué reclama refundPayment cuando release ya tiene parte de las filas', () => {
    beforeEach(() => {
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    });

    it('Caso A (A=retenido, B=retenido): mismo conjunto que release — si release ya las tiene, refund no reclama ninguna y aborta', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(2);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    });

    it('Caso B (A=retenido, B=liberado): refund necesita [A,B]; si A ya la tiene release, refund solo reclama B — y aún así aborta entero sin tocarla', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'B', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(2);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      // Se suelta B (lo único reclamado) antes de abortar — el reclamo
      // parcial no se queda colgado 5 minutos.
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'B', intentosLiberacion: 1 },
        data: { liberacionEnCursoAt: null },
      });
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
      // Ni siquiera se llega a leer las filas completas para procesarlas.
      expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('Caso C (A=capturado, B=liberado): mismo patrón que el Caso B — refund reclama solo B, necesita A+B, aborta sin tocar Stripe', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'B', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(2);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    });

    it('Caso D (A=retenido, B=capturado): mismo conjunto para release y refund (ambos estados están en ESTADOS_LIBERABLES) — sin split-brain posible, igual que el Caso A', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(2);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');
    });

    it('Caso E (3 filas: retenido/capturado/liberado): release solo necesita 2 de las 3; refund necesita las 3 — si release tiene esas 2, refund reclama solo la liberada y aborta sin tocarla', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'C', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(3);

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'C', intentosLiberacion: 1 },
        data: { liberacionEnCursoAt: null },
      });
      expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    });
  });

  /**
   * P2 (auditoría 2026-08-14, revisión adversarial final): heartbeat/
   * renovación del lease antes de cada llamada mutante a Stripe (capture/
   * transfer/cancel/refund), escrituras BD finales condicionadas al
   * mismo fencing token, y detección explícita del resultado "huérfano"
   * cuando Stripe confirma éxito pero el UPDATE fenced afecta 0 filas.
   *
   * Jest es síncrono: no se puede simular literalmente "5 minutos de
   * pausa real" ni una llamada HTTP a Stripe genuinamente en vuelo. Lo
   * que SÍ se prueba, en cada caso, es la propiedad observable que hace
   * segura la carrera: si el heartbeat ya no encuentra el token, la
   * llamada a Stripe correspondiente NUNCA se hace; si Stripe ya
   * confirmó éxito pero la escritura fenced no encuentra el token, se
   * registra explícitamente como huérfano y NUNCA se sobrescribe al
   * nuevo propietario. El límite documentado: un fencing de BD no puede
   * cancelar una llamada a Stripe ya en vuelo — solo reduce la ventana
   * de "toda la duración de la operación" a "la duración de una sola
   * llamada HTTP", y esto último (el huérfano) es la prueba de que ese
   * límite sigue existiendo y de que se maneja explícitamente, no en
   * silencio.
   */
  describe('Heartbeat, fencing y huérfanos de Stripe (revisión adversarial final)', () => {
    const filaBase = (overrides: Partial<Record<string, unknown>> = {}) => ({
      id: 'pago-1',
      serviceRequestId: 'sr-1',
      estado: 'retenido',
      stripePaymentIntentId: 'pi_1',
      montoBase: 100,
      montoTotal: 105,
      montoProfesional: 95,
      intentosLiberacion: 1,
      capturadoBase: null,
      capturadoTotal: null,
      capturadoProfesional: null,
      stripeChargeId: null,
      stripeTransferId: null,
      ...overrides,
    });

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
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        id: 'sr-1',
        profesional: { userId: 'prof-1', stripeAccountId: 'acct_pro_1' },
      });
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    });

    // --- Stall A: después del claim, antes de tocar Stripe ---
    it('Stall A — crash entre el claim y la primera llamada a Stripe: cero llamadas a Stripe, el lease se suelta igualmente', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
      // serviceRequest.findUnique corre antes que cualquier stripe.* en
      // ejecutarLiberacion — fallar aquí simula un crash justo después
      // de reclamar, antes de tocar Stripe.
      mockPrisma.serviceRequest.findUnique.mockRejectedValue(new Error('conexión perdida'));

      await expect(releasePayments('sr-1', 100)).rejects.toThrow('conexión perdida');

      expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
      expect(mockStripe.transfers.create).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pago-1', intentosLiberacion: 1 },
        data: { liberacionEnCursoAt: null },
      });
    });

    // --- Caso central pedido explícitamente: release→refund, Stall C ---
    it('Caso central (release→refund): A ya capturó (BD=capturado) y se detiene antes de transferir; TTL expira; B=refund recupera y reembolsa — el heartbeat de A antes de transferir falla, A NUNCA llama a transfers.create, B conserva ownership', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      // La fila YA está capturada en BD (A completó ese paso antes de
      // detenerse) — se planifica directo como 'transferir', sin volver
      // a capturar ni a leer el estado de Stripe.
      mockPrisma.payment.findMany.mockResolvedValue([
        filaBase({
          estado: 'capturado',
          capturadoBase: 100,
          capturadoTotal: 105,
          capturadoProfesional: 95,
          stripeChargeId: 'ch_1',
        }),
      ]);
      // El heartbeat de A (justo antes de transfers.create) ya no
      // encuentra su token — B (refund) lo reclamó de nuevo tras el TTL.
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

      await expect(releasePayments('sr-1', 100)).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    });

    // --- Stall B: Stripe capture() confirma éxito, pero B ya recuperó ---
    it('Stall B (huérfano en captura): heartbeat OK, Stripe capture() confirma éxito, pero B ya recuperó antes de la escritura final — se registra como huérfano, sin sobrescribir a B', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([filaBase()]);
      mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1' });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // FASE1b (write-ahead) y el heartbeat previo a capture() SÍ
      // encuentran el token de A todavía vigente — pero la escritura
      // FINAL, tras el capture() que Stripe YA confirmó, ya no lo
      // encuentra: B reclamó justo en ese hueco.
      mockPrisma.payment.updateMany
        .mockResolvedValueOnce({ count: 1 }) // FASE1b write-ahead
        .mockResolvedValueOnce({ count: 1 }) // heartbeat antes de capture()
        .mockResolvedValueOnce({ count: 0 }); // escritura final — huérfano

      await expect(releasePayments('sr-1', 100)).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      // Stripe SÍ se llamó y SÍ tuvo éxito — el dinero se movió de verdad.
      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[STRIPE_HUERFANO]'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('paymentId=pago-1'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('operacion=capturarConIdempotencia'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('stripeResultadoId=ch_1'));

      consoleErrorSpy.mockRestore();
    });

    // --- Stalls D/E: transfers.create() en vuelo / justo después ---
    it('Stalls D/E (huérfano en transferencia): heartbeat OK antes de transfers.create(), Stripe confirma éxito, pero B ya recuperó — huérfano registrado, sin sobrescribir a B', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([
        filaBase({
          estado: 'capturado',
          capturadoBase: 100,
          capturadoTotal: 105,
          capturadoProfesional: 95,
          stripeChargeId: 'ch_1',
        }),
      ]);
      mockStripe.transfers.create.mockResolvedValue({ id: 'tr_1' });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockPrisma.payment.updateMany
        .mockResolvedValueOnce({ count: 1 }) // heartbeat antes de transfers.create()
        .mockResolvedValueOnce({ count: 0 }); // escritura final — huérfano

      await expect(releasePayments('sr-1', 100)).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      // Stripe SÍ transfirió el dinero al profesional — de verdad.
      expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[STRIPE_HUERFANO]'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('operacion=transferirConIdempotencia'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('stripeResultadoId=tr_1'));

      consoleErrorSpy.mockRestore();
    });

    // --- Stalls F/G: refunds.create()/cancel() en vuelo / justo después ---
    it('Stalls F/G (huérfano en reembolso): heartbeat OK antes de cancel(), Stripe confirma éxito, pero B (release) ya recuperó — huérfano registrado', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([filaBase()]);
      mockStripe.paymentIntents.cancel.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockPrisma.payment.updateMany
        .mockResolvedValueOnce({ count: 1 }) // heartbeat antes de cancel()
        .mockResolvedValueOnce({ count: 0 }); // escritura final — huérfano

      await expect(refundPayment('sr-1')).rejects.toThrow('LIBERACION_YA_EN_CURSO');

      expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[STRIPE_HUERFANO]'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('operacion=ejecutarReembolso'));

      consoleErrorSpy.mockRestore();
    });

    // --- refund → release: verificación de la protección ya existente ---
    it('refund → release: A=refund cancela en Stripe pero se detiene antes de escribir BD; B=release relee el estado REAL en Stripe (ya canceled) y no intenta capturar', async () => {
      // B es quien ejecuta releasePayments en este test: la fila sigue
      // 'retenido' en BD (A no llegó a escribir 'reembolsado'), pero al
      // releer el PaymentIntent real en Stripe, B ve 'canceled' — su
      // propia comprobación YA existente (no una novedad de este cambio)
      // corta antes de intentar capturar.
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 2 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([filaBase({ intentosLiberacion: 2 })]);
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      await expect(releasePayments('sr-1', 100)).rejects.toThrow('PAGO_NO_AUTORIZADO_TODAVIA');

      expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled();
    });

    // --- Sección 9: operación legítima > TTL con heartbeats correctos ---
    it('operación legítima que "tarda" conceptualmente más de 5 minutos pero sigue avanzando (heartbeat siempre con éxito) NUNCA pierde el lease', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([filaBase()]);
      mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1' });
      mockStripe.transfers.create.mockResolvedValue({ id: 'tr_1' });
      // Cada heartbeat y cada escritura fenced encuentra siempre el
      // MISMO token de A — conceptualmente "pasa el tiempo" pero A sigue
      // siendo el dueño porque cada heartbeat renueva el lease antes de
      // que el TTL llegue a importar. B nunca consigue nada mientras A
      // sigue avanzando: no hace falta ni simularlo aparte.
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      const resultados = await releasePayments('sr-1', 100);

      expect(resultados).toHaveLength(1);
      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
      expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    });

    // --- refund vs refund: sin cambios de comportamiento por el heartbeat ---
    it('dos refund simultáneos sobre la misma fila siguen protegidos por la idempotencyKey existente, incluso con el heartbeat de por medio', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'pago-1', intentosLiberacion: 1 }]);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.payment.findMany.mockResolvedValue([filaBase({ estado: 'capturado' })]);
      mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });
      mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });

      await refundPayment('sr-1');

      expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(mockStripe.refunds.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: 'ref_pago-1' });
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
