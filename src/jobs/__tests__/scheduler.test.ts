jest.mock('../../config/prisma', () => ({
  prisma: {
    tareaProgramada: { upsert: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  },
}));

import { prisma } from '../../config/prisma';
import { ejecutarTareasPendientes, ejecutarTareaAhora, TareaProgramada } from '../scheduler';

const mockPrisma = prisma as any;

function tarea(overrides: Partial<TareaProgramada> = {}): TareaProgramada {
  return {
    nombre: 'tarea-de-prueba',
    descripcion: 'Solo para tests',
    intervaloMs: 10 * 60 * 1000,
    duracionMaximaMs: 5 * 60 * 1000,
    ejecutar: jest.fn().mockResolvedValue('hecho'),
    ...overrides,
  };
}

describe('scheduler — exclusión mutua', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tareaProgramada.upsert.mockResolvedValue({});
    mockPrisma.tareaProgramada.update.mockResolvedValue({});
  });

  it('ejecuta la tarea cuando consigue el lock', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 1 });
    const t = tarea();

    await ejecutarTareasPendientes([t]);

    expect(t.ejecutar).toHaveBeenCalledTimes(1);
  });

  /**
   * El caso que hace seguro el modelo in-process: si algún día hay más de
   * una instancia del backend en Render, solo una debe ejecutar cada
   * tarea. El updateMany condicional es la sección crítica.
   */
  it('NO ejecuta la tarea si otra instancia tiene el lock', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 0 });
    const t = tarea();

    await ejecutarTareasPendientes([t]);

    expect(t.ejecutar).not.toHaveBeenCalled();
  });

  it('pide el lock con vencimiento = ahora + duracionMaximaMs, para que caduque solo si el proceso muere', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 1 });
    const antes = Date.now();

    await ejecutarTareasPendientes([tarea({ duracionMaximaMs: 60_000 })]);

    const { data } = mockPrisma.tareaProgramada.updateMany.mock.calls[0][0];
    const vencimiento = (data.bloqueadoHasta as Date).getTime();
    expect(vencimiento).toBeGreaterThanOrEqual(antes + 60_000);
    expect(vencimiento).toBeLessThan(antes + 65_000);
  });

  /**
   * El calendario vive en BD y no en el uptime del proceso: sin este
   * filtro, cada redeploy de Render (varios al día) volvería a disparar
   * todas las tareas desde cero.
   */
  it('solo toma el lock si ya venció el intervalo desde la última ejecución', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 1 });

    await ejecutarTareasPendientes([tarea({ intervaloMs: 600_000 })]);

    const { where } = mockPrisma.tareaProgramada.updateMany.mock.calls[0][0];
    const condicionIntervalo = where.AND[0].OR;
    expect(condicionIntervalo[0]).toEqual({ ultimaEjecucionAt: null });
    expect(condicionIntervalo[1].ultimaEjecucionAt.lt).toBeInstanceOf(Date);
  });
});

describe('scheduler — aislamiento de fallos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tareaProgramada.upsert.mockResolvedValue({});
    mockPrisma.tareaProgramada.update.mockResolvedValue({});
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Un fallo en una tarea no debe impedir que corran las demás ni tumbar el proceso. */
  it('una tarea que falla no impide que se ejecute la siguiente', async () => {
    const rota = tarea({ nombre: 'rota', ejecutar: jest.fn().mockRejectedValue(new Error('boom')) });
    const sana = tarea({ nombre: 'sana' });

    await expect(ejecutarTareasPendientes([rota, sana])).resolves.toBeUndefined();

    expect(sana.ejecutar).toHaveBeenCalledTimes(1);
  });

  it('registra el error y suma a fallosConsecutivos, soltando el lock', async () => {
    const rota = tarea({ ejecutar: jest.fn().mockRejectedValue(new Error('Stripe caído')) });

    await ejecutarTareasPendientes([rota]);

    expect(mockPrisma.tareaProgramada.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bloqueadoHasta: null,
          ultimoError: 'Stripe caído',
          fallosConsecutivos: { increment: 1 },
        }),
      })
    );
  });

  /**
   * `ultimaEjecucionAt` se actualiza también al fallar: si no, la tarea
   * seguiría "vencida" y se reintentaría en cada tick (cada minuto) en
   * vez de esperar su intervalo, convirtiendo un fallo persistente en un
   * martilleo contra Stripe.
   */
  it('al fallar también marca ultimaEjecucionAt, para respetar el intervalo en vez de reintentar cada minuto', async () => {
    const rota = tarea({ ejecutar: jest.fn().mockRejectedValue(new Error('boom')) });

    await ejecutarTareasPendientes([rota]);

    const { data } = mockPrisma.tareaProgramada.update.mock.calls[0][0];
    expect(data.ultimaEjecucionAt).toBeInstanceOf(Date);
  });

  it('en el camino correcto reinicia fallosConsecutivos y guarda el resumen', async () => {
    await ejecutarTareasPendientes([tarea({ ejecutar: jest.fn().mockResolvedValue('3 pagos recuperados') })]);

    expect(mockPrisma.tareaProgramada.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ultimoResultado: '3 pagos recuperados',
          ultimoError: null,
          fallosConsecutivos: 0,
          bloqueadoHasta: null,
        }),
      })
    );
  });

  it('un fallo consultando la BD no tumba el ciclo entero', async () => {
    mockPrisma.tareaProgramada.updateMany.mockRejectedValueOnce(new Error('BD caída'));
    const sana = tarea({ nombre: 'sana' });

    await expect(ejecutarTareasPendientes([tarea({ nombre: 'primera' }), sana])).resolves.toBeUndefined();
    expect(sana.ejecutar).toHaveBeenCalled();
  });
});

describe('ejecutarTareaAhora (forzado desde el panel de admin)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tareaProgramada.upsert.mockResolvedValue({});
    mockPrisma.tareaProgramada.update.mockResolvedValue({});
  });

  it('se salta el intervalo pero NO el lock', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 1 });

    const resultado = await ejecutarTareaAhora(tarea({ ejecutar: jest.fn().mockResolvedValue('forzada') }));

    expect(resultado).toBe('forzada');
    // Sin condición sobre ultimaEjecucionAt: eso es "saltarse el intervalo".
    const { where } = mockPrisma.tareaProgramada.updateMany.mock.calls[0][0];
    expect(where.AND).toBeUndefined();
    expect(where.OR).toBeDefined(); // pero el lock sí se comprueba
  });

  it('lanza TAREA_YA_EN_CURSO si está corriendo, en vez de duplicarla', async () => {
    mockPrisma.tareaProgramada.updateMany.mockResolvedValue({ count: 0 });
    const t = tarea();

    await expect(ejecutarTareaAhora(t)).rejects.toThrow('TAREA_YA_EN_CURSO');
    expect(t.ejecutar).not.toHaveBeenCalled();
  });
});
