# Hogar SOS — Transferencia técnica de la fase de cierre pre-lanzamiento

**Fecha de cierre:** 2026-08-04
**Alcance:** cierre de los 5 bloqueantes (B1–B5) de la auditoría CTO pre-lanzamiento
**Destinatario:** cualquier ingeniero que retome el proyecto sin haber participado en esta fase
**Siguiente paso previsto:** auditoría independiente externa

> Este documento vive en el repositorio del **backend** porque es donde está el grueso del cambio, pero **cubre los dos repositorios**: `HogarSOS/HogarSOS` (backend) y `HogarSOS/hogarSOS-frontend` (app Flutter).

---

## 1. Resumen ejecutivo

### Estado actual

Hogar SOS es un marketplace de servicios a domicilio (España) con dos roles —cliente y profesional— y pagos retenidos tipo *escrow* vía Stripe Connect. Está **listo para publicar en Google Play** una vez completada la configuración manual del §6. **No está listo para iOS.**

| Métrica | Antes de esta fase | Ahora |
|---|---|---|
| Tests backend (`npx jest`) | 116 | **233** |
| `npx tsc --noEmit` | limpio | limpio |
| `npx eslint src --ext .ts` | 1 warning | 1 warning (el mismo, preexistente) |
| `npm run build` | ok | ok |
| `flutter analyze` | 61 issues, 0 err, 0 warn | **61 issues, 0 err, 0 warn** (idéntico) |
| `flutter test` | 9/9 | 9/9 |
| Migraciones sin aplicar | 0 | **3** |

Ficheros tocados: **28 en backend**, **22 en frontend**.

### Bloques cerrados

| Bloque | Problema original | Estado |
|---|---|---|
| **B1** | Todo el sistema en modo TEST de Stripe: la app "cobraba" sin mover un euro real | ✅ Código cerrado; falta configuración manual |
| **B2** | `releasePayments` no era atómico ni idempotente: el dinero se quedaba atrapado entre la captura y la transferencia, sin recuperación posible | ✅ Cerrado |
| **B3** | Comisión configurada a 0%/0%: la plataforma no ingresaba nada | ✅ Cerrado |
| **B4** | Documentos de identidad servidos públicamente sin autenticación y nunca borrados (RGPD Art. 17 y 32) | ✅ Cerrado |
| **B5** | Autorizaciones de Stripe que caducan a los ~7 días sin que nadie se entere | ⚠️ **Mitigado, no eliminado** |

### Qué queda pendiente

**Depende del propietario (no es código):** claves de Stripe Live, variables en Render, huella de Play App Signing en Firebase, retomar una captura de la ficha de Play. Ver §6.

**Documentado y NO implementado a propósito** (ver §5): verificación de email, borrado del `Customer` de Stripe al eliminar cuenta, solución de raíz de B5, iOS completo.

### Entorno de desarrollo

- **Flutter 3.44.8 stable** en `C:\Users\y_yon\Desktop\flutter_windows_3.44.8-stable\flutter\bin` — **no está en el PATH**, hay que añadirlo en cada sesión.
- **Node 22**, TypeScript, Prisma 5.22, SDK `stripe` 15.12.0.
- **Base de datos:** Supabase (PostgreSQL 15, región Irlanda).
- **Backend:** Render, plan Starter, región Oregón, con disco persistente de 1 GB montado en `/opt/render/project/src/uploads`.

---

## 2. Arquitectura — cómo funciona actualmente

### 2.1 Backend

Express + TypeScript + Prisma sobre PostgreSQL con PostGIS.

```
src/
  config/       prisma, stripe, firebase, mailer, upload, featureFlags, validateEnv
  controllers/  auth, user, serviceRequest, professional, payment, admin,
                postulacion, presupuesto, ampliacion, dispute, review,
                category, upload, archivo
  services/     payment, professional, notification, email, token, archivo
  jobs/         scheduler + 3 tareas programadas
  middlewares/  auth (JWT + RBAC por ruta)
  routes/       una por área + legal, passwordReset, stripeOnboarding
  i18n/         catálogo de notificaciones push (es/en)
```

**Orden del middleware en `index.ts` (importa, no reordenar a la ligera):**

1. `validarConfiguracionOAbortar()` — **antes de abrir el puerto**.
2. `helmet`, `cors`, `compression`.
3. **Webhook de Stripe con `express.raw()`** — debe ir **antes** de `express.json()`, porque Stripe firma el cuerpo crudo.
4. `express.json()`, log de peticiones.
5. `/health` — **antes del rate limiter** a propósito: Render lo sondea constantemente y un 429 lo interpretaría como "backend caído".
6. Rate limiter global (2000 req/15 min).
7. Rutas públicas (web, legales, retorno de Stripe Connect, reset de contraseña) y API.
8. 404 y manejador de errores global.
9. Cierre ordenado en `SIGTERM`/`SIGINT`.

**Autenticación:** el cliente se autentica contra Firebase Auth (email/contraseña o SMS), envía el `firebaseIdToken` a `/api/auth/register` o `/login`, y el backend emite **su propio par de tokens** (access 15 min, refresh 30 días). Los roles y permisos viven en Postgres, no en Firebase.

### 2.2 Flutter

Riverpod para estado, Dio para red, `flutter_secure_storage` para la sesión.

- `ApiService` con interceptor que añade el `Authorization` y refresca el token ante 401.
- `TokenStorage` es un singleton con copia en memoria **y** en almacenamiento seguro. Expone `accessTokenEnMemoria` (síncrono) porque un `ImageProvider` se construye dentro de `build` y no puede esperar a leer del disco.
- l10n con `flutter gen-l10n` (es/en). **Los ficheros generados están commiteados**: si tocas un `.arb`, hay que regenerar.
- Deep link propio `hogarsos://` para el retorno del onboarding de Stripe Connect.

### 2.3 Stripe — visión general

Modelo de **cargos y transferencias separados**: la plataforma cobra al cliente y transfiere al profesional. El profesional tiene una cuenta **Connect Express** (`country: 'ES'`) con la capability `transfers`.

### 2.4 Escrow

```
1. AUTORIZAR   PaymentIntent con capture_method: 'manual'
               → autoriza el cargo en la tarjeta, NO mueve el dinero
2. CAPTURAR    al cerrar el trabajo, con el importe final ya conocido
3. TRANSFERIR  la parte del profesional a su cuenta Connect
```

Puede haber **varias autorizaciones por solicitud**: la inicial (del presupuesto aceptado) más una por cada ampliación de horas aceptada. Cada una es un PaymentIntent **independiente** — no se modifica el importe de uno existente.

Al liberar se recorren en orden, capturando lo necesario hasta cubrir el importe final; lo que sobra se cancela sin cobrarlo. La última puede capturarse parcialmente (capturar menos de lo autorizado libera el resto automáticamente en Stripe).

**Modelo de comisión:** el profesional cotiza un `montoBase`. El cliente paga `montoBase × (1 + %cliente)`, el profesional recibe `montoBase × (1 − %profesional)`. Valores de producción: **5% cliente / 0% profesional**. El término oficial y único en toda la app es **"Gastos de gestión"**.

### 2.5 Stripe Connect

- `accounts.create` con `type: 'express'`, `country: 'ES'`, capability `transfers`.
- `accountLinks.create` genera la URL de onboarding hospedado; el retorno va a `/stripe/onboarding/completado` o `/refresh`, páginas estáticas que reenvían a la app por deep link.
- El estado se deriva de tres flags (`details_submitted`, `charges_enabled`, `payouts_enabled`) en `derivarEstadoCuentaStripe` → `pendiente` | `requiere_actualizacion` | `configurada`.
- Se **re-sincroniza en caliente** antes de transferir, sin fiarse del flag en BD, por si el webhook `account.updated` no llegó.
- **Aprobación semiautomática**: si el profesional tiene tipo, foto, categoría y cuenta Stripe `configurada`, se aprueba solo (`verificadoPor: 'sistema:auto-aprobacion'`).

### 2.6 Customer + Ephemeral Key

El `Customer` de Stripe se crea **de forma perezosa**, en el primer pago real y no al registrarse. Sirve para que el Payment Sheet recuerde la tarjeta (`setup_future_usage: 'off_session'`).

La **Ephemeral Key es de un solo uso**: no se puede reutilizar la de un intento anterior, por eso se genera una nueva en cada respuesta del endpoint de pago, incluidos los reintentos.

`apiVersion: '2024-04-10'` está fijado y **coincide con `LatestApiVersion` del SDK `stripe` 15.12.0** instalado. Verificado, no asumido: al actualizar el SDK hay que revisar ambos a la vez.

### 2.7 Scheduler

Motor propio en `src/jobs/scheduler.ts`, **dentro del propio servicio web**, con lock en base de datos.

```ts
interface TareaProgramada {
  nombre: string;                    // id estable, es la PK en BD
  descripcion: string;
  intervaloMs: number;
  duracionMaximaMs: number;          // cuánto dura el lock
  ejecutar: () => Promise<string>;   // devuelve un resumen legible
}
```

Un ticker cada 60 s evalúa qué tareas tocan. **El calendario vive en la tabla `tareas_programadas`, no en el uptime del proceso.**

**Añadir una tarea:** crear `src/jobs/loQueSea.job.ts` exportando un `TareaProgramada` e importarlo en el array `TAREAS` de `src/jobs/index.ts`. Nada más. Hay un test (`jobs/__tests__/registro.test.ts`) que verifica que toda tarea declarada está registrada.

`SCHEDULER_ENABLED=false` arranca el backend sin tareas (útil en local).

### 2.8 Jobs

| Nombre | Intervalo | Qué hace |
|---|---|---|
| `reintentar-pagos-atascados` | 10 min | Reintenta liberaciones a medias. Backoff exponencial 5 min → 12 h. Salta los errores no reintentables |
| `autorizaciones-por-caducar` | 6 h | Avisa a ambas partes al día 5; al día 6 verifica contra Stripe y marca las caducadas |
| `limpiar-archivos-huerfanos` | 24 h | Borra del disco los archivos de cuentas eliminadas (RGPD) y los huérfanos sin clasificar |

Observables en `GET /api/admin/jobs`; forzables con `POST /api/admin/jobs/:nombre/run`.

### 2.9 Sistema de archivos

**Subida:** `POST /api/uploads/photo` (multipart, campo `foto` + campo `tipo`). `sharp` redimensiona a 1920 px máx., recomprime a JPEG 82 y **elimina los metadatos EXIF, incluida la geolocalización GPS**. Se escribe en el disco persistente y se **registra una fila en `archivos_subidos`** con su tipo y propietario.

**Lectura:** `GET /uploads/:archivo` **con autenticación** y reglas por tipo:

| tipo | quién puede verlo |
|---|---|
| `documento_identidad`, `certificado`, `seguro_rc` | **solo el propietario y un admin** |
| `foto_solicitud`, `foto_disputa` | participantes de esa solicitud + admin |
| `foto_perfil` | cualquier usuario autenticado |

En el frontend, todo widget que cargue una imagen del backend usa `lib/utils/imagen_autenticada.dart`.

### 2.10 Firebase

- **Auth**: email/contraseña y teléfono (SMS). Sin login social → la regla 4.8 de Apple ("Sign in with Apple") **no aplica**.
- **Firestore**: alberga **el chat completo**, que va directo de la app a Firestore **sin pasar por el backend**. Las reglas exigen `autorId == request.auth.uid` y que quien lee/escribe sea el cliente o el profesional de esa solicitud. El backend sincroniza los UIDs a `/service_requests/{id}` con el Admin SDK.
- **Cloud Messaging**: notificaciones push. El token FCM se actualiza en cada arranque con sesión activa; un token inválido se limpia solo.
- **App Android registrada:** `es.hogarsos.app` con 4 huellas SHA (release y debug).

### 2.11 Render

`render.yaml` define el servicio web (plan Starter, Oregón) con:

- `buildCommand`: `npm install --include=dev && npx prisma generate && npm run build && npx prisma migrate deploy && npm prune --omit=dev` — **las migraciones corren aquí**, no en el arranque, porque el CLI de Prisma es una `devDependency` que el `prune` final elimina.
- Disco persistente de 1 GB para `/uploads`.
- `healthCheckPath: /health`.
- Variables con valor en el blueprint (comisiones, JWT, `NODE_ENV`) y variables `sync: false` que hay que rellenar a mano (claves, SMTP, `APP_BASE_URL`).

---

## 3. Cambios realizados en esta fase

### 3.1 Migraciones (3, todas aditivas, **ninguna aplicada todavía**)

| Migración | Contenido |
|---|---|
| `20260804090000_payments_liberacion_idempotente` | Valor `capturado` en `EstadoPago`; 8 columnas en `payments`; índice `payments(estado)` |
| `20260804140000_tareas_programadas` | Tabla `tareas_programadas`; 2 columnas más en `payments` |
| `20260804180000_archivos_subidos_control_acceso` | Enum `TipoArchivo`; tabla `archivos_subidos`; **backfill** de los archivos ya existentes |

> **Nota de PostgreSQL:** `ALTER TYPE ... ADD VALUE` no puede ejecutarse dentro de una transacción en PG < 12, y Prisma envuelve cada migración en una. Supabase corre PG 15, donde sí se permite —con la restricción de que el valor nuevo no puede *usarse* en la misma transacción, y estas migraciones solo lo añaden. Verificado, no asumido.

### 3.2 Tablas nuevas

**`archivos_subidos`** — `id`, `nombre_archivo` (único), `tipo`, `propietario_id` (FK a `users`), `service_request_id`, `bytes`, `created_at`, `eliminado_at`.

**`tareas_programadas`** — `nombre` (PK), `bloqueado_hasta`, `ultima_ejecucion_at`, `ultimo_resultado`, `ultimo_error`, `ejecuciones`, `fallos_consecutivos`.

### 3.3 Columnas nuevas en `payments`

`capturado_base`, `capturado_total`, `capturado_profesional`, `stripe_charge_id`, `capturado_at`, `liberacion_en_curso_at`, `intentos_liberacion`, `ultimo_error_liberacion`, `ultimo_intento_liberacion_at`, `aviso_caducidad_enviado_at`.

### 3.4 Enums

- **`EstadoPago`**: valor nuevo **`capturado`** entre `retenido` y `liberado`.
- **`TipoArchivo`** (nuevo): `foto_perfil`, `foto_solicitud`, `foto_disputa`, `documento_identidad`, `certificado`, `seguro_rc`.

### 3.5 Endpoints

| Método y ruta | Qué hace |
|---|---|
| `GET /uploads/:archivo` | **Sustituye a `express.static`.** Autenticado, con reglas por tipo |
| `GET /api/admin/payments/stuck` | Cola de pagos atascados + importe retenido en la plataforma |
| `POST /api/admin/payments/:serviceRequestId/retry` | Reintento manual de liberación (idempotente) |
| `GET /api/admin/jobs` | Estado de las tareas programadas |
| `POST /api/admin/jobs/:nombre/run` | Fuerza una tarea sin esperar a su ciclo |

`POST /api/uploads/photo` cambia: acepta un campo `tipo` y devuelve `{ url, tipo }`.

### 3.6 Middleware y validaciones

- **`src/config/validateEnv.ts`** (nuevo): valida la configuración al arrancar y **aborta** si es inconsistente.
- **Cierre ordenado en `SIGTERM`**: para el scheduler → deja de aceptar conexiones → espera a las peticiones en vuelo → desconecta Prisma. Tope duro de 15 s.
- `authMiddleware()` aplicado a `/uploads/:archivo`.
- `normalizarNombreArchivo`: `path.basename` + patrón UUID estricto (anti path traversal).

### 3.7 Cambios en Flutter

| Fichero | Cambio |
|---|---|
| `lib/main.dart` | Pantalla roja de bloqueo si build de release + `pk_test` |
| `lib/utils/imagen_autenticada.dart` (nuevo) | Punto único de cabeceras para imágenes del backend |
| `lib/services/token_storage.dart` | Getter síncrono `accessTokenEnMemoria`; `getAccessToken()` cachea en memoria al leer de disco |
| `lib/services/service_request_service.dart` | `subirFoto` exige `tipo` |
| `lib/services/dispute_service.dart` | `subirFoto` fija `foto_disputa` internamente |
| 8 pantallas | `CachedNetworkImageProvider` → `imagenDeRed` (con token) |
| `admin_screen.dart` | `httpHeaders: cabecerasImagen()` en los dos visores de documentos |
| `trabajos_activos_profesional_screen.dart` | Corrección del desglose del profesional (ver §4.10) |
| `android/app/build.gradle.kts` | `GradleException` si falta `key.properties` |
| l10n (5 ficheros) | Texto del distintivo del profesional |

### 3.8 Cambios en Stripe

- **Claves de idempotencia** deterministas en `capture`, `transfers.create`, `paymentIntents.cancel` y `refunds.create`.
- **`transfer_group`** = `pago.id` y `metadata.paymentId` en cada transferencia.
- **`refunds.create`** para deshacer pagos ya capturados (antes solo se sabía cancelar).
- **Evento nuevo en el webhook:** `charge.dispute.created` (contracargos).
- **`requires_action` y `requires_confirmation`** añadidos a los estados reintentables → **3D Secure**.

### 3.9 Cambios en Render y configuración

- `PLATFORM_COMMISSION_CLIENT_PERCENT` de `"0"` a `"5"`.
- Declaradas las variables `SMTP_*` que faltaban en el blueprint.
- Corregido un fallback erróneo: `APP_BASE_URL || 'https://hogarsos.com'` apuntaba a un dominio **.com** que no es el del proyecto (**.es**).

---

## 4. Decisiones de arquitectura — el porqué

> Todo lo de esta sección está decidido con un motivo concreto. **No cambiar sin entender primero el motivo.**

### 4.1 Escrow con captura manual y autorizaciones independientes

`capture_method: 'manual'` autoriza sin capturar. Cada ampliación genera un **PaymentIntent nuevo** en lugar de modificar el importe de uno existente.

**Por qué:** se descartó la autorización incremental nativa de Stripe porque **no todas las tarjetas europeas la soportan de forma fiable**. Varios PaymentIntents independientes funcionan igual en cualquier banco.

### 4.2 Idempotencia: por qué un `try/catch` no bastaba

`releasePayments` hace tres efectos que **no pueden ser atómicos entre sí**:

```
① capture()          (sale el dinero del cliente)
② transfers.create() (entra el dinero al profesional)
③ prisma.update()    (lo registramos)
```

Morir entre ① y ③ dejaba el dinero **capturado al cliente, sin transferir y sin salida**: el pre-chequeo exigía `requires_capture`, y una autorización ya capturada está en `succeeded`, así que todo reintento moría con `PAGO_NO_AUTORIZADO_TODAVIA` **para siempre**.

**El problema no era el manejo del error, era que no quedaba rastro de en qué paso se murió.** La solución es *write-ahead*: la BD registra la intención **antes** de cada efecto y el resultado **después**.

**Tres barreras independientes contra pagar dos veces al profesional:**
1. `stripeTransferId` ya guardado en BD.
2. Clave de idempotencia de Stripe (válida **24 h**).
3. Búsqueda por `transfer_group` — existe **porque las claves de idempotencia caducan a las 24 h** y un pago atascado puede tardar más en detectarse.

**La recuperación usa el mismo camino de código que el flujo feliz**, a propósito: cualquier rutina de reparación separada acabaría divergiendo de la real.

### 4.3 Los importes autorizados son inmutables

El plan de cuánto capturar vive en `capturado_base` / `capturado_total` / `capturado_profesional`, **separado** de `monto_base` / `monto_total` / `monto_profesional`.

**Por qué:** la versión anterior sobrescribía los autorizados al liberar, y por eso un reintento se quedaba sin datos con los que re-planificar. Los `monto*` solo se sobrescriben **al final**, al pasar a `liberado`, para que todo lo que ya leía esas columnas (historial del Centro de Pagos) siga funcionando sin tocar una línea.

### 4.4 Nunca recalcular la comisión al liberar

`releasePayments` **nunca** recalcula el desglose con los porcentajes vigentes: escala proporcionalmente los importes **ya fijados** en cada autorización.

**Por qué:** los porcentajes pueden cambiar entre la autorización y la liberación (que puede ocurrir días después). Cada autorización debe honrar el acuerdo con el que el cliente y el profesional la aceptaron. Desde B2 esta garantía es **estructural**, no solo convencional.

### 4.5 `source_transaction` en las transferencias

Ata la transferencia a los fondos de ese cargo concreto en lugar de al saldo general de la plataforma.

**Por qué:** sin esto, las transferencias fallan cuando el saldo de la plataforma está a cero — que es el caso normal en un marketplace que no acumula fondos.

### 4.6 Leases con expiración en lugar de locks

Un `updateMany` condicional y atómico sobre una columna de timestamp, con caducidad de 5 minutos.

**Por qué no una transacción de BD:** abarcaría las llamadas a Stripe y bloquearía el pool de 5 conexiones durante segundos.
**Por qué no `pg_advisory_lock`:** con pool de conexiones, el `unlock` puede caer en otra conexión distinta a la que hizo el `lock`.
**Por qué con expiración:** un reinicio de Render en pleno vuelo se recupera solo en lugar de dejar el recurso bloqueado para siempre.

**Un solo mecanismo de exclusión mutua en todo el proyecto**, compartido entre pagos y scheduler, a propósito.

### 4.7 Scheduler in-process

**Por qué no un Render Cron Job:** ~7 $/mes **por tarea**, con deploy y variables de entorno duplicados. Con tres tareas y más por venir, multiplica coste y superficie de configuración.
**Por qué no un Background Worker:** proceso permanente ocioso el 99,9% del tiempo.
**La única objeción real al modelo in-process** —duplicación con varias instancias— se cierra con el lock en BD.

**No cierra ninguna puerta:** migrar a un cron externo sería llamar a `ejecutarTareasPendientes()` desde otro entrypoint. Las tareas no se enterarían.

**Dos detalles que parecen menores y no lo son:**
- El calendario vive en BD, no en el uptime del proceso. Sin esto, cada redeploy de Render (varios al día) volvería a disparar todas las tareas desde cero.
- `registrarFallo` actualiza `ultimaEjecucionAt` **también cuando falla**. Sin esto, una tarea rota seguiría "vencida" y se reintentaría en cada tick (cada minuto) en vez de esperar su intervalo — convirtiendo un fallo persistente en un martilleo contra Stripe.

### 4.8 Archivos protegidos: clasificar al escribir, verificar al leer

**La causa raíz no era "falta un middleware".** El sistema perdía la información de qué era cada archivo en el momento de escribirlo: `uploadPhoto` guardaba `<uuid>.jpg` y a partir de ahí el servidor no podía distinguir un DNI de la foto de una cocina. De esa **única** carencia salían los tres síntomas: sin control de acceso, sin borrado y sin auditoría.

**Decisiones concretas:**
- **El `default` del switch de autorización es `false`.** Un tipo nuevo que alguien añada al enum sin añadirlo a las reglas queda **cerrado**, no abierto. Lista blanca, no negra.
- **Los tipos sensibles devuelven 404 y no 403.** Un 403 confirmaría a un tercero que ese documento existe.
- **Las URLs almacenadas NO se reescriben.** La ruta sigue siendo `/uploads/<uuid>.jpg`; solo cambia que ahora exige autenticación. Reescribir URLs en la BD era la parte que sí podía romper datos históricos.
- **El backfill deduce el tipo de la columna de origen** — `documento_identidad_url` solo puede contener un DNI. No adivina nada.
- **Borrado lógico al eliminar la cuenta, físico en la tarea programada.** El acceso se corta al instante; el trabajo de disco (que puede fallar) no bloquea al usuario ni deja la BD inconsistente.

### 4.9 RGPD

- **Anonimizar en lugar de borrar la fila `User`:** hay reseñas, solicitudes y pagos que la referencian, necesarios para el historial del **otro** lado de cada relación y, en los pagos, para la contabilidad (Art. 17.3(b), obligación legal). El usuario de Firebase Auth **sí** se borra por completo.
- **Los archivos sí se borran físicamente.** Antes se ponía la URL a `null` y el JPEG seguía en disco: se le decía al usuario que sus datos estaban borrados mientras su DNI seguía accesible.
- **EXIF eliminado al recomprimir**, incluida la geolocalización GPS.
- **Enumeración de emails cerrada** en `/auth/forgot-password`: la respuesta es siempre la misma exista o no la cuenta.

### 4.10 Payment Sheet, 3D Secure y desglose de comisión

**Por qué solo tarjeta (`payment_method_types: ['card']`):** la cuenta tiene activados por defecto métodos como Klarna, Amazon Pay o Satispay que **no soportan captura manual**. Con `automatic_payment_methods`, el Payment Sheet **falla al inicializarse** por esos métodos incompatibles antes de que el cliente llegue a ver el formulario. La tarjeta es además el único método con sentido para un pago retenido durante días.

**3D Secure (PSD2/SCA):** `requires_action` y `requires_confirmation` están en `ESTADOS_STRIPE_ABANDONABLES`. Si el cliente abre el 3DS de su banco y cierra la app, el PaymentIntent queda en `requires_action`; devolver el mismo `client_secret` permite retomar la autenticación. **Sin esto, el endpoint respondía 409 "No hay nada pendiente de autorizar" y el cliente quedaba sin poder pagar.** Casi invisible en test (las tarjetas de prueba no disparan 3DS), caso normal en live.

**Desglose de comisión al profesional:** se le muestra `montoBase − montoProfesional`, **no** `comisionPlataforma` (que incluye la parte del cliente). Con 5%/0% lo segundo renderizaba "Importe 100 € · Gastos de gestión 5 € · Recibirás 100 €": absurdo y cobrándole visualmente algo que no paga. **El error estuvo oculto mientras ambos porcentajes fueron iguales**, y solo apareció al aplicar la decisión de producto.

### 4.11 Fallo ruidoso ante configuración inconsistente

`validateEnv` aborta el arranque; `main.dart` muestra una pantalla de bloqueo; Gradle lanza `GradleException`.

**Por qué:** todos los fallos de configuración de este proyecto han sido **silenciosos**, y por eso caros. Un servicio caído se detecta en 30 segundos; un servicio que finge cobrar puede tardar semanas. Render mantiene en pie la versión anterior, así que un deploy que falla **no es una caída**.

### 4.12 Otras decisiones vigentes de fases anteriores

- **El chat vive 100% en Firestore**, sin pasar por el backend. Por eso el filtro de contactos es efectivo en postulaciones/presupuestos/ampliaciones (que sí pasan por la API) y **solo cosmético en el chat**.
- **`listNearbyRequests` no expone `direccionTexto` ni coordenadas** antes de aceptar, solo la distancia.
- **`app.set('trust proxy', 1)`**: sin esto, `express-rate-limit` trataría a todos los usuarios como un único cliente detrás del proxy de Render.
- **Los índices de Prisma** están justificados uno a uno con la consulta concreta que los motiva.

---

## 5. Riesgos conocidos

### 5.1 Riesgos pendientes

| Riesgo | Severidad | Por qué sigue abierto |
|---|---|---|
| **`email_verified` nunca se comprueba** | 🟠 | **No es un arreglo pequeño.** `auth_service.dart` llama a `sendEmailVerification()` **después** de que `/auth/register` responda OK, así que en el registro `email_verified` es **siempre `false`**. Añadir la comprobación rompería el 100% de los registros. Exige reestructurar el flujo |
| **PII en Stripe tras eliminar cuenta** | 🟠 | `deleteMe` no llama a `stripe.customers.del()`. El `Customer` conserva nombre, email y teléfono indefinidamente |
| **CORS `origin: true` + `credentials: true`** | 🟠 | Refleja cualquier origen. Contenido porque la auth va por `Authorization: Bearer` y no por cookies |
| **El manejador de errores filtra `err.message`** | 🟠 | Errores de Prisma exponen nombres de tabla y columna |
| **Sin rate limit específico en `/api/auth`** | 🟠 | 2000 req/15 min por IP permite fuerza bruta contra login y bombardeo de `forgot-password` |
| **Refresh tokens de 30 días sin revocación** | 🟠 | JWT puro. Mitigado en parte: `/auth/refresh` revalida que el usuario exista y esté activo |
| **Filtro de contactos del chat solo en cliente** | 🟠 | El chat va directo a Firestore. Fuga de ingresos por desintermediación |
| **Disco de 1 GB sin cuota por usuario** | 🟠 | Un usuario puede llenarlo. La tarea de limpieza ayuda pero no pone cuota |
| **iOS no arranca** | 🔴 (solo iOS) | `com.example.hogarsos` y sin `GoogleService-Info.plist` |

### 5.2 Riesgos aceptados deliberadamente

**Archivos huérfanos dejan de servirse.** Un fichero en disco que ninguna columna referencie no se puede clasificar → 404. Son subidas abandonadas. **Se aceptó perder un huérfano legítimo antes que servir un DNI públicamente.** El borrado físico va en la tarea programada, no en la migración, para dejar una ventana de recuperación.

**`TIPO_POR_DEFECTO = 'foto_solicitud'`** para clientes antiguos que no manden `tipo`. Es el menos permisivo de los no sensibles; nunca se asume un tipo sensible. Razonable pre-lanzamiento, cuestionable si hubiera versiones antiguas en producción.

**Contracargos: aviso, no respuesta automática.** El webhook avisa con el plazo pero no responde. Aportar pruebas es un juicio humano con plazo legal.

**El deploy falla si falta configuración.** `validateEnv` aborta si faltan `APP_BASE_URL` o `STRIPE_WEBHOOK_SECRET` en producción. Es deliberado.

### 5.3 Decisiones de producto pendientes

**B5 — la solución de raíz.** La tarea programada mitiga (avisa antes de que caduque), pero un trabajo a 10 días vista sigue perdiendo la autorización. Dos opciones:

- **Opción A** — limitar `fechaDeseada` a ≤5 días desde la autorización. Barato (validación en `createPaymentIntent`), pero cierra casos de uso reales ("ven cuando puedas la semana que viene").
- **Opción B** — migrar a `SetupIntent` + cobro off-session al cerrar. Sin ventana de caducidad, es el modelo correcto a largo plazo. Pero cambia el contrato con el cliente: ya no hay dinero retenido, solo una tarjeta guardada, y aparece riesgo de impago que hoy no existe.

**Recomendación registrada: A ahora, B más adelante** junto con Google Pay / Apple Pay.

### 5.4 Limitación conocida sin verificar

`accounts.create` pide solo la capability `transfers`, pero `derivarEstadoCuentaStripe` exige `charges_enabled && payouts_enabled` para devolver `'configurada'`, e `intentarAprobacionAutomatica` exige `'configurada'`. **Si Stripe reporta `charges_enabled: false` para cuentas Express de solo-transferencias, la aprobación automática de profesionales no se dispararía nunca.**

Se comporta igual en test y en live: si los profesionales de prueba llegaron a `configurada`, no hay problema. **No se pudo verificar desde el código.**

---

## 6. Checklist de producción

### Stripe

- [ ] Activar la cuenta (datos fiscales + cuenta bancaria).
- [ ] Cambiar a modo **Live**; copiar `sk_live_...` y `pk_live_...`.
- [ ] **Connect → Settings**: aceptar el acuerdo de plataforma y rellenar el perfil en modo Live (si no, el onboarding Express falla).
- [ ] Crear el **webhook en modo Live** → `https://hogarsos.es/api/payments/webhook` con **5** eventos:
  - `payment_intent.amount_capturable_updated`
  - `payment_intent.payment_failed`
  - `payment_intent.canceled`
  - `account.updated`
  - `charge.dispute.created`
- [ ] Copiar el **Signing secret** (`whsec_...`) de ese endpoint Live (es **distinto** del de test).
- [ ] Probar **3D Secure** en test con `4000 0027 6000 3184`, incluyendo abandonar a mitad y reintentar.

### Render

- [ ] `STRIPE_SECRET_KEY` = `sk_live_...`
- [ ] `STRIPE_WEBHOOK_SECRET` = `whsec_...` del endpoint **Live**
- [ ] `APP_BASE_URL` = `https://hogarsos.es` (**sin barra final**)
- [ ] `SMTP_HOST / PORT / SECURE / USER / PASSWORD / FROM` (IONOS)
- [ ] Desplegar y **confirmar en el log**: `[config] Configuración validada. Stripe en modo LIVE.`
- [ ] `npx prisma migrate status` → las 3 migraciones aplicadas.

### Firebase

- [ ] Tras subir el primer `.aab`, añadir las huellas **SHA-1 y SHA-256 de Play App Signing** a la app `es.hogarsos.app`. Sin esto, el login por teléfono degrada a captcha visual para todos.

### Google Play

- [ ] Volver a tomar la **captura 06** (`store_listing/screenshots/06_trabajos_activos_comision.jpg`): muestra "Comisión Hogar SOS" (el término oficial pasó a "Gastos de gestión") y el distintivo "Promoción de lanzamiento", que ya no aparece.
- [ ] Revisar la sección **Seguridad de los datos** — ahora es coherente con B4.
- [ ] Subir `versionCode` en `pubspec.yaml` si Play ya tiene el `+1`.
- [ ] Verificar que las URLs de política de privacidad y eliminación de cuenta responden.

### Android

- [ ] Sustituir el `defaultValue` `pk_test_...` por `pk_live_...` en `lib/main.dart` (~línea 32).
- [ ] Verificar que `android/key.properties` existe (si no, el build **falla a propósito** desde esta fase).
- [ ] `flutter build appbundle --release` y **comprobar que la app no arranca en la pantalla roja**.
- [ ] Hacer un pago real pequeño (5-10 €) de principio a fin y comprobar que el profesional lo recibe.

### iOS

> **No publicable hoy.**

- [ ] Cambiar `PRODUCT_BUNDLE_IDENTIFIER` de `com.example.hogarsos` a `es.hogarsos.app` (Apple rechaza `com.example.*`).
- [ ] Crear la app iOS en Firebase y añadir `ios/Runner/GoogleService-Info.plist` (sin él, `Firebase.initializeApp()` **crashea al arrancar**).
- [ ] Verificar el esquema de deep link `hogarsos://` (ya declarado en `Info.plist`).
- [ ] **No hace falta "Sign in with Apple"**: la regla 4.8 solo aplica con login social de terceros, y aquí solo hay email y teléfono.

---

## 7. Qué NO debe modificarse

> Estabilizado. **No rediseñar salvo que aparezca un bug real y reproducible.** Cada punto tiene su motivo en §4 y comentado en el código.

| Zona | Por qué no tocarla |
|---|---|
| **`payment.service.ts` — fases planificar → congelar → ejecutar** | Es lo que hace la liberación reanudable. Cambiarlo reintroduce B2 |
| **Claves de idempotencia** | Deterministas por `pago.id` a propósito. Hacerlas aleatorias las inutiliza |
| **No recalcular la comisión al liberar** | Es una garantía contractual, no una optimización |
| **`source_transaction` en las transferencias** | Sin esto fallan cuando el saldo de la plataforma está a cero |
| **El lease de 5 minutos** | Coordinado entre `releasePayments` y el scheduler. Bajarlo puede provocar solapamientos |
| **`ultimaEjecucionAt` se actualiza también al fallar** | Sin esto, una tarea rota martillea Stripe cada minuto |
| **`default: false` en `puedeVerArchivo`** | Hace que un tipo nuevo quede cerrado por omisión |
| **404 y no 403 en archivos sensibles** | Un 403 confirma la existencia del documento |
| **`payment_method_types: ['card']`** | Cambiarlo a `automatic_payment_methods` rompe el Payment Sheet |
| **`validateEnv` abortando el arranque** | Deliberado. Un deploy que falla es mejor que un backend que finge cobrar |
| **La pantalla roja de `main.dart`** | Última barrera antes de publicar una app que no cobra |
| **`GradleException` si falta `key.properties`** | Evita un `.aab` firmado con clave de debug que Play rechaza |
| **`TokenStorage.accessTokenEnMemoria`** | Un `ImageProvider` se construye síncronamente dentro de `build` y no puede esperar al almacenamiento seguro |
| **Orden del middleware en `index.ts`** | El webhook necesita `express.raw()` antes de `express.json()`; `/health` antes del rate limiter |
| **Reglas de Firestore** | `autorId == request.auth.uid` cierra la suplantación dentro de un chat autorizado |
| **Índices de Prisma** | Cada uno justificado con la consulta concreta que lo motiva |

---

## 8. Guía de mantenimiento

### Pagos — "un profesional dice que no ha cobrado"

1. `GET /api/admin/payments/stuck` → mirar `importeRetenidoEnPlataforma` y `ultimoError`.
2. Estado **`capturado`** = el dinero salió del cliente y no llegó al profesional. `POST /api/admin/payments/:serviceRequestId/retry`. **Es idempotente, se puede pulsar varias veces.**
3. `ultimoError = PAGO_NO_AUTORIZADO_TODAVIA` → el cliente nunca confirmó el Payment Sheet. **No se arregla reintentando**: tiene que volver a autorizar desde la app.
4. `ultimoError = PROFESIONAL_CUENTA_STRIPE_NO_OPERATIVA` → Stripe no le habilita los pagos (verificación pendiente). Mirar la cuenta Connect en el dashboard.
5. Estado **`reembolsado`** con el trabajo hecho → probablemente **caducó la autorización (B5)**. Buscar en el log `[autorizacionesPorCaducar] Autorización caducada`.

### Stripe — "un cliente no puede pagar"

1. ¿El log de arranque dice `Stripe en modo LIVE`? Si dice TEST, ahí está.
2. Mirar el PaymentIntent en el dashboard. Si está en `requires_action`, es 3DS a medias: el cliente solo tiene que reintentar (el endpoint ya devuelve el mismo `client_secret`).
3. Si responde 409 `PAYMENT_NOTHING_PENDING`, mirar las filas `payments` de esa solicitud: puede haber una `retenido` con un PaymentIntent en un estado no contemplado en `ESTADOS_STRIPE_ABANDONABLES`.

### Webhooks

1. Stripe → Developers → Webhooks → ver los intentos y sus respuestas.
2. **400 "Firma de webhook inválida"** = el `STRIPE_WEBHOOK_SECRET` no corresponde a ese endpoint. **El secreto de test y el de live son distintos.**
3. ¿Están los **5** eventos suscritos? Falta habitual: `charge.dispute.created`.
4. El webhook debe llegar a `/api/payments/webhook`, que se monta **antes** de `express.json()`.

### Archivos — "no se ven las fotos o los documentos"

1. Desde B4, `/uploads/:archivo` **exige sesión**. Sin `Authorization`, 401.
2. ¿El widget usa `imagenDeRed()` o `cabecerasImagen()`? Si usa `CachedNetworkImageProvider` directo, le falta el token.
3. **404** → o no hay fila en `archivos_subidos` (huérfano sin clasificar), o está marcada `eliminado_at`, o es un sensible ajeno (el 404 es deliberado, no un bug).
4. **403** → archivo no sensible sin permiso. Comprobar `service_request_id` de la fila.

### Scheduler — "las tareas no corren"

1. `GET /api/admin/jobs`. `fallosConsecutivos` alto = algo lleva roto varias pasadas, no un fallo puntual.
2. ¿`SCHEDULER_ENABLED=false` en el entorno?
3. Buscar `[scheduler] Iniciado con N tarea(s)` en el log de arranque.
4. Forzar con `POST /api/admin/jobs/:nombre/run` (respeta el lock: 409 si ya está corriendo).

### Firebase

1. **Login por teléfono con captcha visual siempre** → faltan las huellas SHA de Play App Signing en la app `es.hogarsos.app`.
2. **Chat que no carga** → reglas de Firestore. Comprobar que `/service_requests/{id}` tiene `clienteFirebaseUid` y `profesionalFirebaseUid` (los escribe el backend al aceptar).
3. **Push que no llegan** → `users.fcm_token`. Se actualiza en cada arranque con sesión; un token inválido se limpia solo.

### Despliegue — "el deploy falla en Render"

Buscar `❌ CONFIGURACIÓN INVÁLIDA` en el log de build: `validateEnv` lista exactamente qué falta. **Es deliberado.** La versión anterior sigue en pie.

### Contracargos

Buscar `⚠️ CONTRACARGO` en el log (nivel error) y revisar el correo enviado a `SMTP_USER`. **Hay plazo legal**: si se pasa, la disputa se pierde automáticamente. Responder desde Stripe → Payments → Disputes.

---

## 9. Historial técnico

### Punto de partida de esta fase

| Repositorio | Commit base (antes de esta fase) | Commit de entrega |
|---|---|---|
| `HogarSOS/HogarSOS` (backend) | `d9b1c36` — *Añade Stripe Customer + Ephemeral Key…* | **`89d5294`** — *Cierra los 5 bloqueantes de la auditoría pre-lanzamiento (B1-B5)* |
| `HogarSOS/hogarSOS-frontend` | `c117866` — *Cambia el applicationId a es.hogarsos.app* | **`18d3f11`** — *Adapta la app al cierre de los bloqueantes B1-B4* |

Toda esta fase cabe en **un commit por repositorio**. Para ver el cambio completo:

```bash
git diff d9b1c36..89d5294   # backend
git diff c117866..18d3f11   # frontend
```

### Migraciones de esta fase

```
prisma/migrations/
  20260804090000_payments_liberacion_idempotente/    ← B2
  20260804140000_tareas_programadas/                 ← B5 (y cierre de B2)
  20260804180000_archivos_subidos_control_acceso/    ← B4, incluye backfill
```

Ninguna aplicada al entregar. Todas aditivas. Se aplican en orden con `prisma migrate deploy` (que ya corre en el `buildCommand` de Render).

### Ficheros nuevos

**Backend**
```
src/config/validateEnv.ts                              B1
src/config/__tests__/validateEnv.test.ts
src/services/archivo.service.ts                        B4
src/services/__tests__/archivo.service.test.ts
src/controllers/archivo.controller.ts                  B4
src/controllers/__tests__/archivo.controller.test.ts
src/jobs/scheduler.ts                                  B5
src/jobs/index.ts
src/jobs/reintentarPagosAtascados.job.ts               B2
src/jobs/autorizacionesPorCaducar.job.ts               B5
src/jobs/limpiarArchivos.job.ts                        B4
src/jobs/__tests__/scheduler.test.ts
src/jobs/__tests__/reintentarPagosAtascados.test.ts
src/jobs/__tests__/autorizacionesPorCaducar.test.ts
src/jobs/__tests__/registro.test.ts
docs/TRANSFERENCIA_SONNET.md                           (este documento)
```

**Frontend**
```
lib/utils/imagen_autenticada.dart                      B4
```

### Decisiones clave, en orden cronológico

1. **B2** — Write-ahead + estado `capturado` + idempotencia de tres barreras. Descubierto de paso: `refundPayment` no contemplaba pagos ya capturados, lo que dejaba **disputas inmortales**.
2. **B5** — Infraestructura única de tareas programadas, in-process con lock en BD. De paso se añadió el **cierre ordenado en SIGTERM**, que hacía falta para el scheduler.
3. **B1** — Validación de configuración al arrancar + pantalla de bloqueo en release. Corregido un fallback a un dominio **.com** erróneo.
4. **B3** — Comisión a 5%/0%. Destapó un **bug de UI oculto** que solo aparece cuando cliente% ≠ profesional%.
5. **B4** — Tabla `archivos_subidos`, endpoint autenticado, borrado real.
6. **Revisión final** — I8 (firma de release), **3D Secure** (`requires_action`) y contracargos.

### Dos fallos propios que encontraron las herramientas, no la revisión manual

Se dejan documentados porque calibran cuánta confianza merece una revisión sin ejecución real:

1. **El lint destapó que `tareaLimpiarArchivos` estaba importada pero NO añadida al array `TAREAS`.** Compilaba, 227 tests pasaban, y **la tarea no se habría ejecutado nunca**: el borrado RGPD no habría ocurrido jamás, en silencio. Corregido, con `jobs/__tests__/registro.test.ts` como regresión permanente.
2. **Un filtro de severidad de `flutter analyze` poco fiable** estuvo a punto de reportar "0 warnings" habiendo 8 `unused_import` reales.

> **Cómo comparar `flutter analyze` con fiabilidad:** volcar la salida **cruda** a un fichero y diferenciar ahí. El conteo autoritativo es la línea `N issues found`. Filtrar por severidad con pipelines de PowerShell resultó lossy. Ojo también: `Compare-Object` sobre líneas que incluyen número de línea marca como "nuevo" lo que solo se ha **desplazado**.

### Cómo verificar la entrega

```bash
# Backend
cd backend_wizard
npx tsc --noEmit && npx jest && npm run build && npx prisma validate
# Esperado: 233 tests en verde, 0 errores, 1 warning de lint preexistente

# Frontend (añadir Flutter al PATH primero)
cd frontend_wizard
flutter analyze   # esperado: 61 issues, todos `info` de withOpacity, 0 errores, 0 warnings
flutter test      # esperado: 9/9
```

---

## 10. Estado final

### ¿Firmarías esta arquitectura para producción?

**Sí para Android. No para iOS.**

Se firma la arquitectura de pagos, el control de acceso a archivos y la infraestructura de tareas programadas. Lo que mueve dinero y datos sensibles está resuelto **en la arquitectura, no parcheado**: la liberación es idempotente y reanudable con tres barreras contra el doble pago; hay una cola de reintento real en lugar de un comentario prometiéndola; los documentos de identidad ya no son públicos y el borrado de cuenta borra de verdad; y hay validación de arranque que impide desplegar fingiendo cobrar.

iOS no se firma: no arranca.

### ¿Con qué nivel de confianza?

**Alta en lo que está cubierto por tests. Media en lo que no se ha ejecutado contra servicios reales.**

**Alta:** máquina de estados de pagos, control de acceso a archivos, motor del scheduler, validación de configuración. 233 tests, con la lógica de recuperación ejercitada explícitamente.

**Media, en tres puntos concretos que deben constar:**

1. **Nada se ha ejecutado contra Stripe Live.** Los tests son unitarios con Stripe mockeado. El arreglo de 3D Secure en particular es reciente y no se ha probado contra un banco real.
2. **Las migraciones no se han aplicado a ninguna base de datos.** El backfill de B4 es SQL validado solo sintácticamente.
3. **El comportamiento de `charges_enabled` en cuentas Connect de solo-transferencias no se pudo verificar** (§5.4).

### ¿Qué vigilar durante los primeros meses?

**Semana 1 — a diario**
- `GET /api/admin/payments/stuck` → debe estar **siempre vacío**. Cualquier fila con `dineroRetenidoEnPlataforma: true` es dinero real parado.
- `GET /api/admin/jobs` → `fallosConsecutivos` a 0 en las tres tareas.
- Log de Render: buscar `⚠️ CONTRACARGO` y `Autorización caducada`.

**Mes 1**
- **Cuántas autorizaciones caducan.** Es la métrica que decide si B5 necesita la solución de raíz y cuál. Por encima del 5%, hay que actuar.
- **Cuántas aprobaciones de profesional son automáticas vs manuales.** El objetivo de diseño era ~95% automáticas; si son 0%, es el problema de `charges_enabled` de §5.4.
- **Tasa de abandono en el Payment Sheet.** Un pico probablemente sea 3D Secure.

**Meses 2-3**
- **Crecimiento del disco de subidas** (1 GB, sin cuota por usuario).
- **Latencia del backend.** Supabase en Irlanda + Render en Oregón son ~150 ms por consulta; un endpoint con 4 consultas secuenciales son 600 ms de puro cable. **Mover Render a Frankfurt es la mejora individual más rentable disponible.**
- **Carga del sondeo cada 5-10 s** desde las pantallas activas. Es el techo real de escalabilidad.
- **Contracargos.** Con un 5% de comisión, uno solo se come el margen de muchos trabajos.

---

*Documento oficial de entrega de la fase de desarrollo. Cerrado el 2026-08-04.*
