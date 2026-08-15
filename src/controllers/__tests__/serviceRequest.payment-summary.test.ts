import { Prisma } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  prisma: {},
}));

jest.mock('../../config/firebase', () => ({
  firestore: {},
}));

jest.mock('../../services/payment.service', () => ({
  releasePayments: jest.fn(),
  refundPayment: jest.fn(),
}));

jest.mock('../../services/notification.service', () => ({
  enviarNotificacion: jest.fn(),
  enviarNotificacionMasiva: jest.fn(),
  enviarNotificacionCruda: jest.fn(),
}));

import { agregarPagos, calcularPagoPendienteDeAutorizar } from '../serviceRequest.controller';

// Bug real de QA (2026-08-08): createEscrowPaymentIntent crea la fila
// Payment en 'pendiente' en cuanto se crea el PaymentIntent en Stripe,
// ANTES de que el cliente confirme nada con el Payment Sheet. Estas dos
// funciones son las que deciden qué ve el cliente/profesional a partir de
// esas filas — antes de este fix, un Payment 'pendiente' se mostraba
// igual que uno 'retenido' (una solicitud sin autorización real de Stripe
// aparecía como "pagada").
function pago(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    estado: 'retenido',
    montoBase: new Prisma.Decimal(100),
    montoTotal: new Prisma.Decimal(105),
    comisionPlataforma: new Prisma.Decimal(5),
    montoProfesional: new Prisma.Decimal(95),
    presupuestoId: 'pres-1',
    ampliacionId: null,
    ...overrides,
  };
}

describe('agregarPagos', () => {
  it('devuelve null si la única fila está en "pendiente" (Payment Sheet nunca confirmado)', () => {
    expect(agregarPagos([pago({ estado: 'pendiente' })])).toBeNull();
  });

  it('ignora las filas "pendiente" al calcular el resumen si ya hay una confirmada', () => {
    const resultado = agregarPagos([
      pago({ estado: 'pendiente', montoTotal: new Prisma.Decimal(999) }),
      pago({ estado: 'retenido' }),
    ]);

    expect(resultado).toEqual(
      expect.objectContaining({ estado: 'retenido', montoTotal: 105 })
    );
  });

  it('sigue devolviendo el resumen normal cuando ya está retenido/liberado (sin regresión)', () => {
    expect(agregarPagos([pago({ estado: 'liberado' })])).toEqual(
      expect.objectContaining({ estado: 'liberado' })
    );
  });

  // M1 (auditoría Fable 2026-08-15): antes de este fix, 'capturado' caía
  // al 'reembolsado' del final de la cadena, con los importes en 0 —
  // justo lo contrario de lo que pasó (el cliente SÍ pagó).
  it('trata "capturado" como "retenido" (cliente ya cobrado, transferencia al profesional a medias), no como "reembolsado"', () => {
    expect(agregarPagos([pago({ estado: 'capturado' })])).toEqual(
      expect.objectContaining({ estado: 'retenido', montoTotal: 105, montoProfesional: 95 })
    );
  });
});

describe('calcularPagoPendienteDeAutorizar', () => {
  const presupuestoAceptado = { id: 'pres-1', estado: 'aceptado' };

  it('sigue pidiendo autorizar el pago si el único Payment de este presupuesto está "pendiente"', () => {
    const resultado = calcularPagoPendienteDeAutorizar(
      presupuestoAceptado,
      undefined,
      [pago({ estado: 'pendiente' })]
    );

    expect(resultado).toBe(true);
  });

  it('no pide autorizar de nuevo si ya hay una autorización confirmada ("retenido")', () => {
    const resultado = calcularPagoPendienteDeAutorizar(
      presupuestoAceptado,
      undefined,
      [pago({ estado: 'retenido' })]
    );

    expect(resultado).toBe(false);
  });

  it('devuelve false si no hay presupuesto aceptado', () => {
    expect(calcularPagoPendienteDeAutorizar(undefined, undefined, [])).toBe(false);
  });
});
