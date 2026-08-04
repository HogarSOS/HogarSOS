# hogarSOS — Informe final Sprint 3

> **Nota (2026-08-04, auditoría B3):** este informe es un registro histórico del Sprint 3 y se conserva tal cual. La comisión del **18%** que menciona **ya no es la vigente**: el modelo definitivo es 5% al cliente ("Gastos de gestión") y 0% al profesional, con dos variables de entorno independientes (`PLATFORM_COMMISSION_CLIENT_PERCENT` / `PLATFORM_COMMISSION_PROFESSIONAL_PERCENT`). La variable única `PLATFORM_COMMISSION_PERCENT` ya no existe.

**Fecha:** 2026-07-29
**Alcance del sprint:** Validación end-to-end del flujo de pago escrow (Stripe Connect) y corrección de un bug crítico que impedía liberar pagos a los profesionales.

## 1. Resumen ejecutivo

El flujo de pago descrito en el README (autorización → captura → transferencia vía Stripe Connect, con reembolso por disputa) estaba implementado pero **nunca se había probado de extremo a extremo contra Stripe real**. Al hacerlo se encontró un bug que rompía la liberación de pago en el 100% de los casos. Se corrigió, se volvió a probar, y el fix se replicó en la segunda copia del backend existente en el repositorio (`backend_final_v3`).

**Resultado: el flujo de pago (autorización, captura, transferencia, comisión y reembolso) funciona correctamente en modo Test, y el fix está integrado y validado en `backend_wizard` (commiteado y en `origin/main`).**

## 2. Bug encontrado y corregido

**Archivo:** `src/services/payment.service.ts`, función `releasePayment`.

**Síntoma:** al completar un servicio, `PATCH /service-requests/:id/complete` devolvía `202` con `"la liberación del pago falló y se reintentará"` — el servicio quedaba marcado como completado pero el pago nunca se transfería al profesional, sin ningún log del error real (el `catch` del controlador lo silenciaba).

**Causa raíz:** `stripe.transfers.create()` recibía `source_transaction: pago.stripePaymentIntentId` — un ID de **PaymentIntent** (`pi_...`). Stripe exige ahí un ID de **Charge** (`ch_...`); son recursos distintos en su API. Con el ID equivocado, Stripe respondía `No such charge`.

**Fix:** capturar el `PaymentIntent` y tomar `latest_charge` del objeto devuelto para usarlo como `source_transaction`.

```diff
- await stripe.paymentIntents.capture(pago.stripePaymentIntentId);
+ const paymentIntentCapturado = await stripe.paymentIntents.capture(pago.stripePaymentIntentId);
...
+ const chargeId = typeof paymentIntentCapturado.latest_charge === 'string'
+   ? paymentIntentCapturado.latest_charge
+   : paymentIntentCapturado.latest_charge?.id;

  const transfer = await stripe.transfers.create({
    ...
-   source_transaction: pago.stripePaymentIntentId,
+   source_transaction: chargeId,
  });
```

**Impacto si no se hubiera detectado:** en producción, cada profesional habría completado servicios sin cobrar nunca — el dinero del cliente quedaría autorizado/capturado en Stripe pero atrapado en la cuenta de la plataforma, sin transferirse. Bug de severidad crítica para el modelo de negocio (marketplace de dos lados).

## 3. Pruebas realizadas

Todo lo siguiente se ejecutó contra la base de datos Supabase real del proyecto y la API de Stripe en **modo Test**, con datos y cuentas de prueba eliminados al finalizar (ver §5).

| Caso | Resultado |
|---|---|
| Onboarding de Stripe Connect (profesional, cuenta `express`, país ES) vía navegador, flujo real de la app | ✅ Cuenta con `transfers: active`, sin requisitos pendientes |
| Autorización de pago (`POST /payments/intent`, `capture_method: manual`) | ✅ PaymentIntent creado, comisión calculada correctamente (18%) |
| Confirmación con tarjeta de prueba de Stripe | ✅ `requires_capture` |
| Completar servicio → captura + transferencia (`PATCH /service-requests/:id/complete`) — **antes del fix** | ❌ Fallaba silenciosamente (bug descrito arriba) |
| Mismo flujo — **después del fix** | ✅ `Payment.estado = liberado`, transferencia real (test) creada, reparto correcto (30€ → 5.40€ plataforma / 24.60€ profesional) |
| Reembolso por disputa (`PATCH /admin/disputes/:id/resolve`, `resuelta_cliente`) | ✅ `Payment.estado = reembolsado`, PaymentIntent cancelado en Stripe |

### Backend `backend_final_v3`

Se confirmó que `backend_final_v3` es el mismo proyecto (`hogarsos-backend`, mismo `package.json`, mismo código fuente) pero sin `.git` ni `.env` — es un snapshot de referencia, no un despliegue activo. Se aplicó el mismo diff exacto (confirmado con `diff`: archivos idénticos tras el cambio).

| Verificación | Resultado |
|---|---|
| `npm install` | ✅ |
| `npx prisma generate` + `npx prisma validate` | ✅ Esquema válido |
| `npx tsc --noEmit` | ⚠️ Falla — **por motivos no relacionados con este fix** (ver abajo) |

No se repitió el E2E completo (Stripe/Supabase) en `backend_final_v3` porque el código post-fix es idéntico al ya validado en `backend_wizard`, y habría significado configurar una segunda instancia contra la misma base de datos de producción sin beneficio adicional — decisión acordada con el usuario.

**Errores de compilación preexistentes en `backend_final_v3` (no introducidos por este fix, confirmado porque `payment.service.ts` compila sin errores y los fallos están en otros dos archivos que no se tocaron):**
1. `src/config/firebase.ts` — falta `firebase-key.json` (esperado: este snapshot nunca tuvo credenciales configuradas).
2. `src/services/token.service.ts` — error de tipos en `jwt.sign(...)` con `expiresIn`. `backend_wizard` ya tiene este mismo problema corregido con un cast (`as jwt.SignOptions['expiresIn']`) que nunca se sincronizó a `backend_final_v3`.

Además, `backend_final_v3/src/services/token.service.ts` imprime `JWT_SECRET` completo en consola (`console.log('JWT_SECRET =', process.env.JWT_SECRET)`), algo ya corregido en `backend_wizard` (que solo loguea `!!process.env.JWT_SECRET`). Riesgo de seguridad si esta versión llegara a desplegarse con logs compartidos — ver backlog Sprint 4.

**Conclusión:** ambos backends contienen ahora el fix de Stripe, pero han divergido en otros puntos. Recomendación: tratar `backend_wizard` como fuente de verdad única y archivar o eliminar `backend_final_v3` (ver Sprint 4).

## 4. Otras verificaciones

| Verificación | Resultado |
|---|---|
| `flutter analyze` (frontend_wizard) | ⚠️ 42 avisos, todos nivel `info` (sin errores ni warnings bloqueantes) — mayormente `withOpacity` deprecado, imports innecesarios y sugerencias de `const`; un identificador (`en_progreso`) que no sigue `lowerCamelCase` |
| `flutter test` (frontend_wizard) | ✅ 1/1 test pasa — smoke test mínimo (`test/widget_test.dart`), no ejercita `HogarSOSApp` real porque requiere `Firebase.initializeApp()` con credenciales no disponibles en entorno de test |
| Tests automatizados en `backend_wizard` / `backend_final_v3` | ⚠️ No existen (sin script `test`, sin archivos `*.test.ts`/`*.spec.ts`) |
| `backend_wizard` compila (`tsc --noEmit`) | ✅ Sin errores |

## 5. Higiene de datos de prueba

- Usuarios, solicitudes, pagos y disputa de prueba creados en Supabase: **eliminados** (0 filas restantes verificado tras limpieza).
- Cuenta Stripe Connect de prueba (`acct_1TyW30...`): **eliminada**.
- Ficheros temporales con tokens JWT de prueba: **eliminados**.

## 6. Control de versiones

- **`backend_wizard`** (`https://github.com/HogarSOS/HogarSOS.git`, rama `main`): commit `c2f2ced` — solo el fix de `payment.service.ts`, **pusheado**. Quedan 8 archivos modificados y una carpeta de migración sin trackear, pertenecientes a otro trabajo en curso — deliberadamente **no** incluidos en este commit, a la espera de revisión del usuario.
- **`backend_final_v3`**: sin repositorio Git — el fix existe únicamente como cambio de archivo en disco, sin historial de versiones posible en su estado actual.

## 7. Conclusión del sprint

El objetivo del sprint — validar y dejar funcionando el flujo de pago con Stripe — **se cumplió**: el bug crítico está corregido, probado end-to-end (caso feliz y reembolso) y el fix está integrado en el repositorio activo (`backend_wizard`, pusheado a `main`). `flutter analyze` y `flutter test` se ejecutaron correctamente (sin errores, solo avisos menores de lint) una vez localizado el Flutter SDK en la máquina. Quedan documentados como hallazgos para el Sprint 4: la deriva entre `backend_wizard` y `backend_final_v3`, y la ausencia de tests automatizados reales (más allá del smoke test mínimo del frontend y ningún test en ningún backend).
