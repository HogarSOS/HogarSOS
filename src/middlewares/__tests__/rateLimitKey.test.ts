import jwt from 'jsonwebtoken';
import { claveRateLimit, claveIp } from '../rateLimitKey';

describe('claveRateLimit — cupo por usuario autenticado, por IP para anónimos (CGNAT)', () => {
  const SECRET = 'secreto-de-test';

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it('token válido: la clave es el userId — dos usuarios tras la misma IP no comparten cupo', () => {
    const tokenA = jwt.sign({ userId: 'user-a' }, SECRET);
    const tokenB = jwt.sign({ userId: 'user-b' }, SECRET);

    const claveA = claveRateLimit(`Bearer ${tokenA}`, '83.45.1.1');
    const claveB = claveRateLimit(`Bearer ${tokenB}`, '83.45.1.1');

    expect(claveA).toBe('u:user-a');
    expect(claveB).toBe('u:user-b');
    expect(claveA).not.toBe(claveB);
  });

  it('token con firma falsa: NO estrena cupo propio, cae al cupo por IP (anti-bypass)', () => {
    const forjado = jwt.sign({ userId: 'atacante-1' }, 'otro-secreto');
    expect(claveRateLimit(`Bearer ${forjado}`, '83.45.1.1')).toBe('ip:83.45.1.1');
  });

  it('token caducado: cae al cupo por IP (el 401 se lo dará authMiddleware después)', () => {
    const caducado = jwt.sign({ userId: 'user-a' }, SECRET, { expiresIn: '-1s' });
    expect(claveRateLimit(`Bearer ${caducado}`, '83.45.1.1')).toBe('ip:83.45.1.1');
  });

  it('sin cabecera Authorization: cupo por IP', () => {
    expect(claveRateLimit(undefined, '83.45.1.1')).toBe('ip:83.45.1.1');
  });

  it('cabecera que no es Bearer: cupo por IP', () => {
    expect(claveRateLimit('Basic abc123', '83.45.1.1')).toBe('ip:83.45.1.1');
  });

  it('token válido sin userId en el payload: cupo por IP', () => {
    const sinUserId = jwt.sign({ otraCosa: true }, SECRET);
    expect(claveRateLimit(`Bearer ${sinUserId}`, '83.45.1.1')).toBe('ip:83.45.1.1');
  });
});

describe('claveIp — normalización', () => {
  it('IPv4 va tal cual', () => {
    expect(claveIp('83.45.1.1')).toBe('ip:83.45.1.1');
  });

  it('IPv6 se agrupa por /64 (privacy extensions no estrenan cupo)', () => {
    expect(claveIp('2a02:9130:aaaa:bbbb:1111:2222:3333:4444')).toBe('ip6:2a02:9130:aaaa:bbbb');
    expect(claveIp('2a02:9130:aaaa:bbbb:5555:6666:7777:8888')).toBe('ip6:2a02:9130:aaaa:bbbb');
  });

  it('IP ausente: clave fija (no revienta)', () => {
    expect(claveIp(undefined)).toBe('ip:desconocida');
  });
});
