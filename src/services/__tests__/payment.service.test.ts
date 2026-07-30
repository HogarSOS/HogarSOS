jest.mock('../../config/prisma', () => ({
  prisma: {
    payment: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    serviceRequest: { findUnique: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: { capture: jest.fn(), cancel: jest.fn(), create: jest.fn() },
    transfers: { create: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { releasePayment, refundPayment, calcularComision } from '../payment.service';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

describe('calcularComision', () => {
  it('calcula la comisión de la plataforma (18% por defecto) y el resto para el profesional', () => {
    const { comision, montoProfesional } = calcularComision(100);
    expect(comision).toBe(18);
    expect(montoProfesional).toBe(82);
  });
});

describe('releasePayment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const pagoRetenido = {
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    estado: 'retenido',
    stripePaymentIntentId: 'pi_123',
    montoProfesional: 82,
  };

  const solicitudConProfesional = {
    id: 'sr-1',
    profesional: { stripeAccountId: 'acct_pro_1' },
  };

  /**
   * Regresión directa del bug del Sprint 3: stripe.transfers.create()
   * exige el ID del CHARGE (ch_...), no el del PaymentIntent (pi_...) —
   * en producción esto hacía que NINGÚN profesional cobrara nunca,
   * porque Stripe respondía "No such charge" con el ID equivocado y el
   * error quedaba silenciado más arriba. Este test falla si alguien
   * vuelve a pasar pago.stripePaymentIntentId (o cualquier otra cosa
   * que no sea el charge capturado) a source_transaction.
   */
  it('usa el charge capturado (latest_charge), no el PaymentIntent, como source_transaction', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(pagoRetenido);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ ...pagoRetenido, estado: 'liberado' });

    await releasePayment('sr-1');

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_transaction: 'ch_456' })
    );
  });

  it('extrae el id si latest_charge llega expandido como objeto en vez de string', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(pagoRetenido);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({
      id: 'pi_123',
      latest_charge: { id: 'ch_999' },
    });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ ...pagoRetenido, estado: 'liberado' });

    await releasePayment('sr-1');

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ source_transaction: 'ch_999' })
    );
  });

  it('transfiere el monto correcto (en céntimos) a la cuenta Stripe Connect del profesional', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(pagoRetenido);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue(solicitudConProfesional);
    mockStripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_123', latest_charge: 'ch_456' });
    mockStripe.transfers.create.mockResolvedValue({ id: 'tr_789' });
    mockPrisma.payment.update.mockResolvedValue({ ...pagoRetenido, estado: 'liberado' });

    await releasePayment('sr-1');

    expect(mockStripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 8200, destination: 'acct_pro_1' })
    );
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceRequestId: 'sr-1' },
        data: expect.objectContaining({ estado: 'liberado', stripeTransferId: 'tr_789' }),
      })
    );
  });

  it('lanza PAGO_NO_ENCONTRADO si la solicitud no tiene pago asociado', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(null);
    await expect(releasePayment('sr-inexistente')).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });

  it('lanza PAGO_NO_RETENIDO si el pago ya se liberó o reembolsó antes', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ ...pagoRetenido, estado: 'liberado' });
    await expect(releasePayment('sr-1')).rejects.toThrow('PAGO_NO_RETENIDO');
  });

  it('lanza PROFESIONAL_SIN_CUENTA_STRIPE si el profesional no completó el onboarding de Connect', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(pagoRetenido);
    mockPrisma.serviceRequest.findUnique.mockResolvedValue({
      id: 'sr-1',
      profesional: { stripeAccountId: null },
    });
    await expect(releasePayment('sr-1')).rejects.toThrow('PROFESIONAL_SIN_CUENTA_STRIPE');
  });
});

describe('refundPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cancela el PaymentIntent en Stripe y marca el pago como reembolsado', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      serviceRequestId: 'sr-1',
      stripePaymentIntentId: 'pi_123',
    });
    mockStripe.paymentIntents.cancel.mockResolvedValue({ id: 'pi_123', status: 'canceled' });
    mockPrisma.payment.update.mockResolvedValue({ serviceRequestId: 'sr-1', estado: 'reembolsado' });

    await refundPayment('sr-1');

    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_123');
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { serviceRequestId: 'sr-1' },
      data: { estado: 'reembolsado' },
    });
  });

  it('lanza PAGO_NO_ENCONTRADO si la solicitud nunca llegó a tener un pago autorizado', async () => {
    // Caso real: cancelServiceRequest ahora permite cancelar una
    // solicitud "pendiente" (nunca hubo pago) además de "aceptada" — el
    // llamador debe poder distinguir este caso de un fallo real de
    // Stripe para no tratarlo como un error a registrar.
    mockPrisma.payment.findUnique.mockResolvedValue(null);
    await expect(refundPayment('sr-sin-pago')).rejects.toThrow('PAGO_NO_ENCONTRADO');
  });
});
