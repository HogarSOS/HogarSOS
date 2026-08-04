/**
 * Validación de configuración al arrancar (auditoría B1).
 *
 * POR QUÉ FALLAR AL ARRANCAR Y NO SEGUIR
 * --------------------------------------
 * Casi todos los fallos de configuración de este proyecto han sido
 * silenciosos, no ruidosos, y por eso caros:
 *
 * - Una `pk_test` compilada en el .aab: la app "cobra", el Payment Sheet
 *   dice OK y no se mueve un euro real. Nadie se entera hasta que un
 *   profesional reclama.
 * - `APP_BASE_URL` sin definir: las URLs de las fotos subidas apuntan a
 *   `localhost` para todo el mundo, y el retorno del onboarding de
 *   Stripe Connect va a un dominio que ni siquiera es el nuestro.
 * - `STRIPE_WEBHOOK_SECRET` vacío: el webhook rechaza TODOS los eventos
 *   de Stripe con firma inválida, y el estado de las cuentas Connect
 *   solo se actualiza si el profesional abre su perfil.
 *
 * Un servicio caído es visible en 30 segundos. Un servicio que finge
 * cobrar puede tardar semanas en detectarse y para entonces hay dinero
 * y reputación de por medio. Por eso esto aborta el arranque.
 */

export interface ResultadoValidacion {
  errores: string[];
  avisos: string[];
}

const esProduccion = () => process.env.NODE_ENV === 'production';

/** Variables sin las que el backend no puede funcionar en ningún entorno. */
const OBLIGATORIAS_SIEMPRE = [
  'DATABASE_URL',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
] as const;

/**
 * Variables cuya ausencia en producción CORROMPE el comportamiento (no
 * solo lo degrada): sin ellas el sistema hace cosas incorrectas en
 * silencio, así que es mejor no arrancar.
 */
const OBLIGATORIAS_EN_PRODUCCION = [
  // Sin esto, los enlaces de retorno de Stripe Connect y las URLs de las
  // fotos subidas apuntan a un sitio equivocado (localhost).
  'APP_BASE_URL',
  // Sin esto, `stripe.webhooks.constructEvent` rechaza TODOS los eventos
  // de Stripe por firma inválida, y el estado de las cuentas Connect solo
  // se actualiza si el profesional abre su perfil.
  'STRIPE_WEBHOOK_SECRET',
] as const;

/**
 * Variables cuya ausencia DEGRADA una función pero no corrompe nada más.
 * Aviso muy visible en cada arranque, no error: tumbar el servicio entero
 * por no poder mandar correos sería peor que la propia carencia.
 *
 * Aun así hay que verlas: sin SMTP, `forgotPassword` traga el error del
 * envío y responde igualmente `{success:true}` — la recuperación de
 * contraseña queda rota sin que nadie lo note.
 */
const RECOMENDADAS_EN_PRODUCCION = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;

function validarPorcentaje(nombre: string, errores: string[]): void {
  const bruto = process.env[nombre];

  // Sin definir es correcto: payment.service tiene un valor por defecto.
  if (bruto === undefined) return;

  // Definida pero VACÍA no lo es, y es el caso más peligroso de todos:
  // `Number('')` es 0, no NaN, así que una variable que alguien borró en
  // el dashboard de Render pasaría como "0% de comisión" sin que nada
  // fallara. Es exactamente el fallo silencioso de B3 (plataforma sin
  // ingresos), así que se trata como error explícito y no como 0.
  if (bruto.trim() === '') {
    errores.push(`${nombre} está definida pero VACÍA. Number('') es 0, así que se aplicaría un 0% de comisión en silencio. Bórrala del todo para usar el valor por defecto, o ponle un número.`);
    return;
  }

  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
    errores.push(`${nombre}="${bruto}" no es un porcentaje válido (0-100). Un valor inválido haría que Number() diera NaN y TODOS los importes cobrados salieran mal.`);
  }
}

export function validarConfiguracion(): ResultadoValidacion {
  const errores: string[] = [];
  const avisos: string[] = [];

  for (const clave of OBLIGATORIAS_SIEMPRE) {
    if (!process.env[clave]) errores.push(`Falta la variable de entorno obligatoria ${clave}.`);
  }

  const faltanRecomendadas = RECOMENDADAS_EN_PRODUCCION.filter((c) => !process.env[c]);

  if (esProduccion()) {
    for (const clave of OBLIGATORIAS_EN_PRODUCCION) {
      if (!process.env[clave]) {
        errores.push(`Falta ${clave}, obligatoria con NODE_ENV=production.`);
      }
    }
    if (faltanRecomendadas.length > 0) {
      avisos.push(
        `Faltan ${faltanRecomendadas.join(', ')}: NO se podrán enviar correos. ` +
        'La recuperación de contraseña seguirá respondiendo {success:true} sin mandar nada.'
      );
    }
  } else {
    for (const clave of [...OBLIGATORIAS_EN_PRODUCCION, ...RECOMENDADAS_EN_PRODUCCION]) {
      if (!process.env[clave]) avisos.push(`${clave} sin definir (tolerable fuera de producción).`);
    }
  }

  // --- Coherencia de Stripe: test vs live ---
  const claveStripe = process.env.STRIPE_SECRET_KEY ?? '';
  const esClaveTest = claveStripe.startsWith('sk_test');
  const esClaveLive = claveStripe.startsWith('sk_live');

  if (claveStripe && !esClaveTest && !esClaveLive) {
    errores.push('STRIPE_SECRET_KEY no empieza por "sk_test" ni por "sk_live". ¿Has pegado una clave publicable (pk_) o restringida (rk_) por error?');
  }

  if (esProduccion() && esClaveTest) {
    // Escotilla explícita para el caso legítimo de un entorno de staging
    // que corre con NODE_ENV=production contra Stripe de pruebas.
    if (process.env.ALLOW_STRIPE_TEST_IN_PRODUCTION === 'true') {
      avisos.push('NODE_ENV=production con una clave de Stripe de TEST. Permitido por ALLOW_STRIPE_TEST_IN_PRODUCTION=true — ningún pago será real.');
    } else {
      errores.push(
        'NODE_ENV=production con una clave de Stripe de TEST (sk_test...). Ningún pago sería real: los clientes verían "pago correcto" y los profesionales no cobrarían nunca. ' +
        'Pon la clave sk_live en Render, o define ALLOW_STRIPE_TEST_IN_PRODUCTION=true si esto es un entorno de pruebas a propósito.'
      );
    }
  }

  // El secreto del webhook es distinto en test y en live: reutilizar el
  // de test con claves live hace que TODOS los eventos se rechacen con
  // firma inválida — y el síntoma (nada se actualiza solo) no apunta
  // para nada a la causa.
  const secretoWebhook = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  if (secretoWebhook && !secretoWebhook.startsWith('whsec_')) {
    errores.push('STRIPE_WEBHOOK_SECRET no empieza por "whsec_". Debe ser el "Signing secret" del endpoint, no su ID (we_...) ni la clave de API.');
  }

  // --- APP_BASE_URL ---
  const baseUrl = process.env.APP_BASE_URL;
  if (baseUrl) {
    if (!/^https?:\/\//.test(baseUrl)) {
      errores.push(`APP_BASE_URL="${baseUrl}" debe incluir el esquema (https://...).`);
    } else if (esProduccion() && !baseUrl.startsWith('https://')) {
      errores.push(`APP_BASE_URL="${baseUrl}" debe ser https en producción: Stripe rechaza return_url que no lo sean.`);
    }
    if (baseUrl.endsWith('/')) {
      avisos.push(`APP_BASE_URL termina en "/", lo que produce URLs con doble barra ("${baseUrl}/uploads/..."). Quítala.`);
    }
  }

  validarPorcentaje('PLATFORM_COMMISSION_CLIENT_PERCENT', errores);
  validarPorcentaje('PLATFORM_COMMISSION_PROFESSIONAL_PERCENT', errores);

  return { errores, avisos };
}

/**
 * Ejecuta la validación y aborta el arranque si algo es inconsistente.
 * Se llama lo antes posible en index.ts, ANTES de abrir el puerto: si la
 * configuración está mal, es preferible que Render marque el despliegue
 * como fallido y mantenga la versión anterior en pie.
 */
export function validarConfiguracionOAbortar(): void {
  const { errores, avisos } = validarConfiguracion();

  for (const aviso of avisos) {
    console.warn(`[config] AVISO: ${aviso}`);
  }

  if (errores.length === 0) {
    const modoStripe = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'LIVE' : 'TEST';
    console.log(`[config] Configuración validada. Stripe en modo ${modoStripe}.`);
    return;
  }

  console.error('');
  console.error('========================================');
  console.error('❌ CONFIGURACIÓN INVÁLIDA — no se arranca');
  console.error('========================================');
  for (const error of errores) console.error(`  · ${error}`);
  console.error('========================================');
  console.error('');

  throw new Error(`Configuración inválida: ${errores.length} error(es). Ver el detalle arriba.`);
}
