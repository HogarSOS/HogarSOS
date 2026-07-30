import admin from 'firebase-admin';

/**
 * Normaliza un private key PEM pegado en una variable de entorno.
 *
 * El problema de fondo (no es solo "\n" vs salto real): el editor de
 * variables de entorno de Render — como el de la mayoría de PaaS — es
 * un campo pensado para valores de una sola línea. Según cómo se
 * pegue el valor, puede llegar de formas distintas:
 *   1. Con "\n" literales (dos caracteres: barra invertida + n), que
 *      es lo que hay si se copia el texto crudo del JSON del service
 *      account tal cual.
 *   2. Con saltos de línea reales, si el navegador no colapsa el
 *      pegado multilínea.
 *   3. Envuelto en comillas dobles, si se copió incluyendo las
 *      comillas del campo JSON ("private_key": "...").
 * Cualquier de estos tres — o una combinación — produce "Invalid PEM
 * formatted message" si solo se cubre el caso 1. Esta función cubre
 * los tres.
 */
function normalizarPrivateKey(valor: string): string {
  let key = valor.trim();

  // Caso 3: quitar comillas envolventes si están.
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }

  // Caso 1: des-escapar "\n" literales a saltos de línea reales.
  key = key.replace(/\\n/g, '\n');

  return key;
}

// En producción (Render y plataformas similares) las credenciales llegan
// por variables de entorno: firebase-key.json está en .gitignore por ser
// un secreto, así que no existe en el repo desplegado. En desarrollo
// local, si esas variables no están definidas, cae al JSON local para no
// romper el flujo de trabajo que ya existía antes de este cambio.
function credencialFirebase(): admin.ServiceAccount {
  // Opción preferida: el JSON completo del service account, en
  // base64, en UNA sola variable de entorno. Al ser base64 no hay
  // saltos de línea que un campo de texto de una sola línea pueda
  // mutilar — es inmune al problema de fondo, no un parche sobre él.
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key,
    };
  }

  // Fallback: las tres variables sueltas, con el private key
  // normalizado ante cualquiera de los formatos en los que suela
  // llegar pegado a mano.
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: normalizarPrivateKey(FIREBASE_PRIVATE_KEY),
    };
  }

  // Desarrollo local: cae al JSON local si no hay ninguna env var. Tiene
  // que ser require() dinámico (no un import estático) porque este
  // archivo no existe en producción — un import de nivel de módulo
  // rompería el build ahí aunque esta rama nunca se ejecute.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../firebase-key.json') as admin.ServiceAccount;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credencialFirebase()),
  });
}

export const firebaseAuth = admin.auth();
export const firestore = admin.firestore();