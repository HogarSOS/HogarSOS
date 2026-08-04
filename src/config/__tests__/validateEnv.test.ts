import { validarConfiguracion, validarConfiguracionOAbortar } from '../validateEnv';

/**
 * Auditoría B1. El objetivo de estas comprobaciones no es "validar
 * variables" en abstracto: es que los fallos de configuración de este
 * proyecto, que históricamente han sido SILENCIOSOS (una pk_test en
 * release, APP_BASE_URL sin definir, el webhook secret de test con
 * claves live), pasen a ser ruidosos y bloqueantes.
 */

const ENTORNO_ORIGINAL = { ...process.env };

/** Configuración mínima válida de producción, sobre la que cada test rompe una sola cosa. */
function entornoProduccionValido(): void {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://u:p@host:5432/db';
  process.env.JWT_SECRET = 'un-secreto-cualquiera';
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc123';
  process.env.FIREBASE_PROJECT_ID = 'hogarsos';
  process.env.FIREBASE_CLIENT_EMAIL = 'a@b.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----';
  process.env.APP_BASE_URL = 'https://hogarsos.es';
  process.env.SMTP_HOST = 'smtp.ionos.es';
  process.env.SMTP_USER = 'soporte@hogarsos.es';
  process.env.SMTP_PASSWORD = 'x';
  process.env.SMTP_FROM = 'Hogar SOS <soporte@hogarsos.es>';
  delete process.env.ALLOW_STRIPE_TEST_IN_PRODUCTION;
  delete process.env.PLATFORM_COMMISSION_CLIENT_PERCENT;
  delete process.env.PLATFORM_COMMISSION_PROFESSIONAL_PERCENT;
}

beforeEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
  entornoProduccionValido();
});

afterAll(() => {
  process.env = ENTORNO_ORIGINAL;
});

describe('validarConfiguracion — coherencia de Stripe', () => {
  it('acepta una configuración de producción completa con clave live', () => {
    expect(validarConfiguracion().errores).toEqual([]);
  });

  /**
   * EL bloqueante B1: con una sk_test en producción, el cliente ve
   * "pago correcto" y no se mueve un euro real. Un servicio caído se
   * detecta en 30 segundos; uno que finge cobrar puede tardar semanas.
   */
  it('RECHAZA arrancar en producción con una clave de Stripe de test', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';

    const { errores } = validarConfiguracion();

    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('TEST');
  });

  it('permite la clave de test en producción si se pide explícitamente (staging)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.ALLOW_STRIPE_TEST_IN_PRODUCTION = 'true';

    const { errores, avisos } = validarConfiguracion();

    expect(errores).toEqual([]);
    expect(avisos.join(' ')).toContain('ningún pago será real');
  });

  it('permite la clave de test fuera de producción sin protestar', () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';

    expect(validarConfiguracion().errores).toEqual([]);
  });

  it('detecta que se ha pegado una clave publicable donde va la secreta', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_live_abc123';

    expect(validarConfiguracion().errores.join(' ')).toContain('publicable');
  });

  /**
   * El "Signing secret" del webhook es DISTINTO en test y en live.
   * Confundirlo con el ID del endpoint (we_...) hace que Stripe firme
   * bien pero nosotros rechacemos todos los eventos — y el síntoma (nada
   * se actualiza solo) no apunta para nada a la causa.
   */
  it('detecta un STRIPE_WEBHOOK_SECRET que no es un signing secret', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'we_1234567890';

    expect(validarConfiguracion().errores.join(' ')).toContain('whsec_');
  });
});

describe('validarConfiguracion — variables obligatorias', () => {
  it.each(['DATABASE_URL', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'FIREBASE_PROJECT_ID'])(
    'falla si falta %s en cualquier entorno',
    (clave) => {
      process.env.NODE_ENV = 'development';
      delete process.env[clave];

      expect(validarConfiguracion().errores.join(' ')).toContain(clave);
    }
  );

  it('exige APP_BASE_URL en producción (si no, las fotos y el retorno de Stripe apuntan a localhost)', () => {
    delete process.env.APP_BASE_URL;

    expect(validarConfiguracion().errores.join(' ')).toContain('APP_BASE_URL');
  });

  it('exige STRIPE_WEBHOOK_SECRET en producción', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(validarConfiguracion().errores.join(' ')).toContain('STRIPE_WEBHOOK_SECRET');
  });

  /**
   * Deliberadamente aviso y NO error: sin SMTP la recuperación de
   * contraseña queda rota, pero tumbar el servicio entero por no poder
   * mandar correos sería peor que la propia carencia.
   */
  it('avisa (sin abortar) si falta la configuración de SMTP en producción', () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;

    const { errores, avisos } = validarConfiguracion();

    expect(errores).toEqual([]);
    expect(avisos.join(' ')).toContain('SMTP_HOST');
  });
});

describe('validarConfiguracion — APP_BASE_URL', () => {
  it('exige https en producción porque Stripe rechaza return_url que no lo sean', () => {
    process.env.APP_BASE_URL = 'http://hogarsos.es';

    expect(validarConfiguracion().errores.join(' ')).toContain('https');
  });

  it('exige que incluya el esquema', () => {
    process.env.APP_BASE_URL = 'hogarsos.es';

    expect(validarConfiguracion().errores.join(' ')).toContain('esquema');
  });

  it('avisa de la barra final, que produce URLs con doble barra', () => {
    process.env.APP_BASE_URL = 'https://hogarsos.es/';

    const { errores, avisos } = validarConfiguracion();

    expect(errores).toEqual([]);
    expect(avisos.join(' ')).toContain('doble barra');
  });
});

describe('validarConfiguracion — porcentajes de comisión (B3)', () => {
  it('acepta los valores de producción 5 / 0', () => {
    process.env.PLATFORM_COMMISSION_CLIENT_PERCENT = '5';
    process.env.PLATFORM_COMMISSION_PROFESSIONAL_PERCENT = '0';

    expect(validarConfiguracion().errores).toEqual([]);
  });

  /**
   * Un valor no numérico haría que `Number()` diera NaN en
   * calcularDesglose, y TODOS los importes cobrados saldrían mal sin
   * que nada fallara de forma visible.
   */
  it.each(['cinco', '', '-1', '150'])('rechaza un porcentaje inválido (%s)', (valor) => {
    process.env.PLATFORM_COMMISSION_CLIENT_PERCENT = valor;

    expect(validarConfiguracion().errores.join(' ')).toContain('PLATFORM_COMMISSION_CLIENT_PERCENT');
  });
});

describe('validarConfiguracionOAbortar', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('lanza (aborta el arranque) si hay errores', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';

    expect(() => validarConfiguracionOAbortar()).toThrow('Configuración inválida');
  });

  it('no lanza si todo está bien, e informa del modo de Stripe', () => {
    expect(() => validarConfiguracionOAbortar()).not.toThrow();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('LIVE'));
  });
});
