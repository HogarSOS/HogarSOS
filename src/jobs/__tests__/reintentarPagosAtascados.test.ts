jest.mock('../../config/prisma', () => ({
  prisma: { payment: { findMany: jest.fn() } },
}));

jest.mock('../../services/payment.service', () => ({
  reintentarLiberacion: jest.fn(),
  // P2 #7: el job importa la misma lista que usa heartbeat() para no
  // duplicarla — el mock tiene que ofrecer el mismo valor real.
  ESTADOS_DISPUTA_BLOQUEANTE: [
    'needs_response',
    'under_review',
    'warning_needs_response',
    'warning_under_review',
    'lost',
  ],
}));

import { prisma } from '../../config/prisma';
import { reintentarLiberacion } from '../../services/payment.service';
import { reintentarPagosAtascados } from '../reintentarPagosAtascados.job';

const mockPrisma = prisma as any;
const mockReintentar = reintentarLiberacion as jest.Mock;

const HACE_UNA_HORA = new Date(Date.now() - 60 * 60 * 1000);

function pago(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pago-1',
    serviceRequestId: 'sr-1',
    estado: 'capturado',
    createdAt: HACE_UNA_HORA,
    intentosLiberacion: 1,
    ultimoIntentoLiberacionAt: null,
    ultimoErrorLiberacion: null,
    ...overrides,
  };
}

describe('reintentarPagosAtascados', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReintentar.mockResolvedValue([{ id: 'pago-1' }]);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('reintenta un pago capturado sin transferir', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pago()]);

    const resumen = await reintentarPagosAtascados();

    expect(mockReintentar).toHaveBeenCalledWith('sr-1');
    expect(resumen).toContain('1 pago(s) liberado(s)');
  });

  /**
   * Varias autorizaciones (inicial + ampliaciones) pueden pertenecer a la
   * misma solicitud, y releasePayments trabaja por solicitud entera: sin
   * agrupar se llamaría varias veces a lo mismo y todas menos la primera
   * chocarían con LIBERACION_YA_EN_CURSO.
   */
  it('agrupa por solicitud: no llama dos veces por la misma aunque tenga varias autorizaciones', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pago({ id: 'pago-1', serviceRequestId: 'sr-1' }),
      pago({ id: 'pago-2', serviceRequestId: 'sr-1', ampliacionId: 'ampl-1' }),
      pago({ id: 'pago-3', serviceRequestId: 'sr-2' }),
    ]);

    await reintentarPagosAtascados();

    expect(mockReintentar).toHaveBeenCalledTimes(2);
    expect(mockReintentar).toHaveBeenCalledWith('sr-1');
    expect(mockReintentar).toHaveBeenCalledWith('sr-2');
  });

  /**
   * PAGO_NO_AUTORIZADO_TODAVIA significa que el cliente nunca confirmó
   * el Payment Sheet: no se arregla reintentando, hace falta que vuelva
   * a autorizar desde la app. Reintentarlo cada 10 minutos solo gastaría
   * llamadas a Stripe y enterraría en ruido los que sí son recuperables.
   */
  it('omite los pagos cuyo último error no se arregla reintentando', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pago({ ultimoErrorLiberacion: 'PAGO_NO_AUTORIZADO_TODAVIA' }),
    ]);

    const resumen = await reintentarPagosAtascados();

    expect(mockReintentar).not.toHaveBeenCalled();
    expect(resumen).toContain('1 omitida(s)');
  });

  it('respeta el backoff exponencial: no reintenta si el último intento es demasiado reciente', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      // 2 intentos ⇒ espera mínima de 15 min; el último fue hace 1 min.
      pago({ intentosLiberacion: 2, ultimoIntentoLiberacionAt: new Date(Date.now() - 60 * 1000) }),
    ]);

    await reintentarPagosAtascados();

    expect(mockReintentar).not.toHaveBeenCalled();
  });

  it('sí reintenta una vez superada la espera del backoff', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      // 2 intentos ⇒ espera de 15 min; el último fue hace 1 hora.
      pago({ intentosLiberacion: 2, ultimoIntentoLiberacionAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);

    await reintentarPagosAtascados();

    expect(mockReintentar).toHaveBeenCalledWith('sr-1');
  });

  /**
   * LIBERACION_YA_EN_CURSO no es un fallo: alguien (el propio profesional
   * cerrando el trabajo, o un admin) lo está liberando ahora mismo.
   */
  it('no cuenta como fallo que la liberación ya esté en curso', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pago()]);
    mockReintentar.mockRejectedValue(new Error('LIBERACION_YA_EN_CURSO'));

    const resumen = await reintentarPagosAtascados();

    expect(resumen).not.toContain('Fallos:');
  });

  it('recoge los fallos reales en el resumen sin abortar el resto', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      pago({ serviceRequestId: 'sr-1' }),
      pago({ id: 'pago-2', serviceRequestId: 'sr-2' }),
    ]);
    mockReintentar
      .mockRejectedValueOnce(new Error('Stripe 500'))
      .mockResolvedValueOnce([{ id: 'pago-2' }]);

    const resumen = await reintentarPagosAtascados();

    expect(mockReintentar).toHaveBeenCalledTimes(2);
    expect(resumen).toContain('Fallos:');
    expect(resumen).toContain('sr-1: Stripe 500');
  });

  /** Sin este margen, la tarea competiría con la petición HTTP que acaba de fallar. */
  it('solo mira pagos con cierta antigüedad, para no competir con la petición que acaba de fallar', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);

    await reintentarPagosAtascados();

    const { where } = mockPrisma.payment.findMany.mock.calls[0][0];
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(where.OR).toEqual([
      { estado: 'capturado' },
      { estado: 'retenido', serviceRequest: { estado: 'completada' } },
    ]);
  });

  /**
   * P2 #7: exclusión temprana, solo por eficiencia — evita gastar una
   * llamada a Stripe en un pago que heartbeat() iba a rechazar de todas
   * formas. Se comprueba el WHERE que de verdad se manda a Prisma
   * (`findMany` está mockeado sin más, así que esto no prueba que
   * Postgres filtre bien — prueba que el job CONSTRUYE la condición
   * correcta, que es lo único que este archivo puede verificar).
   */
  it('el WHERE de candidatos excluye pagos con disputa bloqueante', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([]);

    await reintentarPagosAtascados();

    const { where } = mockPrisma.payment.findMany.mock.calls[0][0];
    expect(where.AND).toEqual([
      {
        OR: [
          { stripeDisputeStatus: null },
          {
            stripeDisputeStatus: {
              notIn: ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review', 'lost'],
            },
          },
        ],
      },
    ]);
  });

  /**
   * Si la disputa llega justo entre la selección del job y la ejecución
   * real, la exclusión temprana ya no puede evitarlo (el candidato ya
   * se seleccionó) — heartbeat() es quien lo bloquea de verdad. Desde
   * el punto de vista del job, esto se ve como reintentarLiberacion()
   * rechazando con PAGO_EN_DISPUTA, exactamente igual que cualquier
   * otro fallo real: se cuenta en `fallos`, no se omite en silencio.
   */
  it('si la disputa llega entre selección y ejecución, el job registra el rechazo del heartbeat como fallo real', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([pago({ serviceRequestId: 'sr-1' })]);
    mockReintentar.mockRejectedValueOnce(new Error('PAGO_EN_DISPUTA'));

    const resumen = await reintentarPagosAtascados();

    expect(resumen).toContain('Fallos:');
    expect(resumen).toContain('sr-1: PAGO_EN_DISPUTA');
  });
});
