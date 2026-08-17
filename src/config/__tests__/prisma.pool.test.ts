import { urlConPoolAjustado, limiteDePool } from '../prisma';

const URL_BASE = 'postgresql://user:secret@host.example.com:5432/postgres?connection_limit=5&pool_timeout=10';

describe('urlConPoolAjustado (pool 5→10, auditoría de escalabilidad 2026-08-17)', () => {
  afterEach(() => {
    delete process.env.DB_CONNECTION_LIMIT;
  });

  it('sobreescribe connection_limit a 10 por defecto y conserva el resto de la URL', () => {
    const resultado = urlConPoolAjustado(URL_BASE)!;
    const url = new URL(resultado);
    expect(url.searchParams.get('connection_limit')).toBe('10');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
    expect(url.hostname).toBe('host.example.com');
    expect(url.password).toBe('secret');
  });

  it('añade connection_limit aunque la URL original no lo tuviera', () => {
    const resultado = urlConPoolAjustado('postgresql://u:p@h:5432/db')!;
    expect(new URL(resultado).searchParams.get('connection_limit')).toBe('10');
  });

  it('respeta DB_CONNECTION_LIMIT como escape sin deploy', () => {
    process.env.DB_CONNECTION_LIMIT = '7';
    const resultado = urlConPoolAjustado(URL_BASE)!;
    expect(new URL(resultado).searchParams.get('connection_limit')).toBe('7');
  });

  it('ignora DB_CONNECTION_LIMIT inválido (0, negativo, no numérico, >50)', () => {
    for (const invalido of ['0', '-3', 'abc', '99']) {
      process.env.DB_CONNECTION_LIMIT = invalido;
      const resultado = urlConPoolAjustado(URL_BASE)!;
      expect(new URL(resultado).searchParams.get('connection_limit')).toBe('10');
    }
  });

  it('devuelve la URL tal cual si no es parseable, y undefined si falta', () => {
    expect(urlConPoolAjustado('esto no es una url')).toBe('esto no es una url');
    expect(urlConPoolAjustado(undefined)).toBeUndefined();
  });
});

describe('limiteDePool', () => {
  it('coincide con el connection_limit efectivo (el que calienta el pool warmer)', () => {
    // DATABASE_URL real del entorno de test (viene de .env) — el límite
    // efectivo debe ser el mismo que aplica urlConPoolAjustado.
    const efectiva = urlConPoolAjustado(process.env.DATABASE_URL);
    const esperado = efectiva ? Number(new URL(efectiva).searchParams.get('connection_limit')) : 5;
    expect(limiteDePool()).toBe(esperado);
  });
});
