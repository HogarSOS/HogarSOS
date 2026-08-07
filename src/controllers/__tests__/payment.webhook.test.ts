import { Request, Response } from 'express';

jest.mock('../../config/prisma', () => ({
  prisma: {
    payment: { findUnique: jest.fn(), updateMany: jest.fn() },
    professional: { findFirst: jest.fn() },
  },
}));

jest.mock('../../config/stripe', () => ({
  stripe: { webhooks: { constructEvent: jest.fn() } },
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/email.service', () => ({
  enviarEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/professional.service', () => ({
  sincronizarEstadoCuentaStripe: jest.fn(),
}));

import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { stripeWebhook } from '../payment.controller';

const mockPrisma = prisma as any;
const mockStripe = stripe as any;

function fakeRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(): Request {
  return { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as unknown as Request;
}

describe('stripeWebhook — precondiciones de estado (auditoría, hallazgo #6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  // Stripe no garantiza el orden de entrega de webhooks. Un evento
  // payment_failed/canceled que llega DESPUÉS de que releasePayments ya
  // capturó o liberó esa misma autorización no debe degradarla — la
  // única defensa posible desde este lado es exigir que la fila siga en
  // 'retenido' en el propio WHERE del updateMany.
  it('payment_intent.payment_failed solo puede degradar una fila que sigue "retenido"', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1' } },
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_1', estado: 'retenido' },
      data: { estado: 'fallido' },
    });
  });

  it('payment_intent.canceled solo puede degradar una fila que sigue "retenido"', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_1' } },
    });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await stripeWebhook(fakeReq(), fakeRes());

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_1', estado: 'retenido' },
      data: { estado: 'reembolsado' },
    });
  });

  it('responde 400 si la firma del webhook es inválida', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('firma inválida');
    });
    const res = fakeRes();

    await stripeWebhook(fakeReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });
});
