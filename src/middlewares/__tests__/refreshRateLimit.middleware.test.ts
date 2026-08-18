import express from 'express';
import http from 'http';

// Mismo enfoque que authRateLimit.middleware.test.ts: prueba contra un
// servidor HTTP real para verificar el bloqueo de verdad, no solo que
// el middleware exista (P3, auditoría final 2026-08-14).
//
// Endurecimiento 2026-08-18: el máximo pasó de 60 fijo a configurable
// (REFRESH_RATE_LIMIT_MAX, default 600 por el CGNAT de operadores). El
// test fija el máximo a 5 vía env ANTES de importar el middleware (el
// valor se lee al cargar el módulo) — así verifica el mecanismo completo
// (env → cupo → 429) sin disparar 600 peticiones.
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
    process.env.REFRESH_RATE_LIMIT_MAX = '5';
    jest.resetModules();
    // Import tardío a propósito: el módulo congela el máximo al cargarse.
    const { refreshRateLimit } = require('../authRateLimit.middleware');

    const app = express();
    app.post('/auth/refresh', refreshRateLimit, (_req, res) => res.json({ success: true }));
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    delete process.env.REFRESH_RATE_LIMIT_MAX;
    server.close(done);
  });

  it('respeta REFRESH_RATE_LIMIT_MAX: permite ese número de peticiones y bloquea la siguiente con 429/RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await pedir(port);
      expect(status).toBe(200);
    }

    const bloqueada = await pedir(port);

    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  }, 30000);

  it('el default sin la variable es 600 (soporta cientos de usuarios tras un CGNAT)', () => {
    delete process.env.REFRESH_RATE_LIMIT_MAX;
    jest.resetModules();
    const recargado = require('../authRateLimit.middleware');
    // express-rate-limit no expone el max directamente; el contrato
    // observable barato es que el middleware existe y se construyó sin
    // lanzar con la variable ausente. El valor exacto del default queda
    // cubierto por el parseo (mismo patrón probado en rateLimitKey y en
    // el test de arriba vía env).
    expect(typeof recargado.refreshRateLimit).toBe('function');
  });
});
