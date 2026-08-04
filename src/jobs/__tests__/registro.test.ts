import { TAREAS } from '../index';

/**
 * Regresión de un fallo real cometido al añadir la tarea de limpieza de
 * archivos (B4): el archivo se creó y se importó en `jobs/index.ts`,
 * pero se olvidó añadirlo al array `TAREAS`. El código compilaba, los
 * tests pasaban y la tarea NO se habría ejecutado nunca — es decir, el
 * borrado de archivos exigido por el RGPD Art. 17 no habría llegado a
 * ocurrir jamás, en silencio.
 *
 * Lo detectó el lint (variable importada sin usar), no los tests. Esto
 * lo convierte en una comprobación explícita.
 */
describe('registro de tareas programadas', () => {
  it('cada tarea declarada existe y está registrada', () => {
    const nombres = TAREAS.map((t) => t.nombre);

    expect(nombres).toEqual(
      expect.arrayContaining([
        'reintentar-pagos-atascados',
        'autorizaciones-por-caducar',
        'limpiar-archivos-huerfanos',
      ])
    );
  });

  it('no hay nombres duplicados (el nombre es la clave primaria en BD)', () => {
    const nombres = TAREAS.map((t) => t.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it('toda tarea tiene intervalo y duración máxima coherentes', () => {
    for (const tarea of TAREAS) {
      expect(tarea.intervaloMs).toBeGreaterThan(0);
      expect(tarea.duracionMaximaMs).toBeGreaterThan(0);
      expect(typeof tarea.ejecutar).toBe('function');
      expect(tarea.descripcion.length).toBeGreaterThan(10);
      // Si el lock durase más que el intervalo, la tarea se saltaría
      // ciclos enteros esperando a que caducase su propio lock.
      expect(tarea.duracionMaximaMs).toBeLessThanOrEqual(tarea.intervaloMs);
    }
  });
});
