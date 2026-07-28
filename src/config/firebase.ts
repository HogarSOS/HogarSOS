import admin from 'firebase-admin';

// En producción (Render y plataformas similares) las credenciales llegan
// por variables de entorno: firebase-key.json está en .gitignore por ser
// un secreto, así que no existe en el repo desplegado. En desarrollo
// local, si esas variables no están definidas, cae al JSON local para no
// romper el flujo de trabajo que ya existía antes de este cambio.
function credencialFirebase(): admin.ServiceAccount {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // La mayoría de plataformas (Render incluida) no permiten pegar
      // saltos de línea reales en variables de entorno — la clave se
      // guarda con "\n" literales y hay que des-escaparlos aquí.
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    } as admin.ServiceAccount;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../firebase-key.json') as admin.ServiceAccount;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credencialFirebase()),
  });
}

export const firebaseAuth = admin.auth();
export const firestore = admin.firestore();