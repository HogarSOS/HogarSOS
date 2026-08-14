import express from 'express';
import http from 'http';
import { authRateLimit } from '../authRateLimit.middleware';

// Prueba real contra un servidor HTTP de verdad (no mocks): un
// rate-limiter que se rompe en producción (mal aplicado, contando por
// la IP equivocada detrás de un proxy, etc.) es invisible en un test
// que solo comprueba "la función existe" — hay que verificar el
// comportamiento real de bloqueo, que es justo lo que motivó añadir
// esto (auditoría de cierre 2026-08-13: sin esto, fuerza bruta contra
// login/forgot-password no tenía ningún límite práctico).
function pedir(port: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/auth/login', method: 'POST' }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('authRateLimit', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    const app = express();
    app.post('/auth/login', authRateLimit, (_req, res) => res.json({ success: true }));
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('permite las primeras 20 peticiones y bloquea la 21 con 429/RATE_LIMITED', async () => {
    for (let i = 0; i < 20; i++) {
      const { status } = await pedir(port);
      expect(status).toBe(200);
    }

    const bloqueada = await pedir(port);

    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  }, 20000);
});
