const mockLimpiarArchivos = jest.fn();
jest.mock('../../services/archivo.service', () => ({
  limpiarArchivos: (...args: unknown[]) => mockLimpiarArchivos(...args),
}));

import { limpiarArchivosSubidos, tareaLimpiarArchivos } from '../limpiarArchivos.job';

describe('limpiarArchivosSubidos', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resume sin mencionar fallos cuando todo el borrado fue bien', async () => {
    mockLimpiarArchivos.mockResolvedValue({ borradosMarcados: 3, huerfanosBorrados: 2, fallos: 0 });

    const resumen = await limpiarArchivosSubidos();

    expect(resumen).toBe('3 archivo(s) de cuentas eliminadas borrados del disco, 2 huérfano(s) sin clasificar eliminados');
    expect(resumen).not.toMatch(/fallo/i);
  });

  // Comportamiento real que le importa a quien mira los logs: un fallo
  // de borrado no debe pasar desapercibido dentro de un resumen que por
  // lo demás suena a éxito.
  it('menciona explícitamente los fallos cuando alguno ocurre', async () => {
    mockLimpiarArchivos.mockResolvedValue({ borradosMarcados: 1, huerfanosBorrados: 0, fallos: 2 });

    const resumen = await limpiarArchivosSubidos();

    expect(resumen).toContain('2 fallo(s) de borrado — se reintentarán mañana.');
  });

  it('propaga un resumen de "0 y 0" sin fallos como éxito silencioso normal', async () => {
    mockLimpiarArchivos.mockResolvedValue({ borradosMarcados: 0, huerfanosBorrados: 0, fallos: 0 });

    const resumen = await limpiarArchivosSubidos();

    expect(resumen).toBe('0 archivo(s) de cuentas eliminadas borrados del disco, 0 huérfano(s) sin clasificar eliminados');
  });
});

describe('tareaLimpiarArchivos (config de la tarea programada)', () => {
  it('corre una vez al día, con margen de sobra bajo el tope de duración', () => {
    expect(tareaLimpiarArchivos.intervaloMs).toBe(24 * 60 * 60 * 1000);
    expect(tareaLimpiarArchivos.duracionMaximaMs).toBeLessThanOrEqual(tareaLimpiarArchivos.intervaloMs);
  });

  it('apunta ejecutar a la misma función exportada (evita que se desincronicen)', () => {
    expect(tareaLimpiarArchivos.ejecutar).toBe(limpiarArchivosSubidos);
  });
});
