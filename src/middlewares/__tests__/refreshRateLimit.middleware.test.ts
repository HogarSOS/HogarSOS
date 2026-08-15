import express from 'express';
import http from 'http';
import { refreshRateLimit } from '../authRateLimit.middleware';

// Mismo enfoque que authRateLimit.middleware.test.ts: prueba contra un
// servidor HTTP real para verificar el bloqueo de verdad, no solo que
// el middleware exista (P3, auditoría final 2026-08-14).
function pedir(port: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/auth/refresh', method: 'POST' }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('refreshRateLimit', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    const app = express();
    app.post('/auth/refresh', refreshRateLimit, (_req, res) => res.json({ success: true }));
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('permite las primeras 60 peticiones y bloquea la 61 con 429/RATE_LIMITED', async () => {
    for (let i = 0; i < 60; i++) {
      const { status } = await pedir(port);
      expect(status).toBe(200);
    }

    const bloqueada = await pedir(port);

    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  }, 30000);
});
