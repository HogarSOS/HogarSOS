# hogarSOS — Backlog priorizado Sprint 4

**Objetivo del sprint:** dejar la app lista para enviar a revisión en Google Play y App Store.

Basado en el estado actual documentado en `README.md`, los `TODO`/`UnimplementedError` ya marcados en el código, y los hallazgos del Sprint 3 (`SPRINT_3_INFORME_FINAL.md`).

---

## P0 — Bloqueantes para poder enviar a revisión

Sin esto, ninguna de las dos tiendas acepta la app o el envío es directamente inviable.

1. **Login con Google / Apple** — `loginConGoogle()` lanza `UnimplementedError` a propósito. Apple **exige** "Sign in with Apple" si la app ofrece login con otro proveedor social (Google) — es motivo automático de rechazo si falta.
2. **Firma de release** — Android: generar keystore de producción + `key.properties` + configurar `build.gradle` para release firmado (hoy probablemente usa firma debug). iOS: certificados de distribución + provisioning profile + registrar el Bundle ID en App Store Connect.
3. **Iconos de app y splash screen** en todas las densidades/tamaños requeridos (hoy previsiblemente son los placeholder por defecto de Flutter — Apple rechaza icons genéricos).
4. **Permisos nativos con descripción de uso** — `NSLocationWhenInUseUsageDescription` / `NSLocationAlwaysAndWhenInUseUsageDescription` (ubicación en tiempo real de profesionales), `NSCameraUsageDescription` y `NSPhotoLibraryUsageDescription` (subida de fotos/documentos de verificación) en iOS; permisos runtime equivalentes en Android. Sin esto, Apple rechaza en la primera revisión.
5. **Política de privacidad pública** (URL real, no un placeholder) enlazada en ambas fichas de tienda — obligatoria porque la app procesa pagos, ubicación en tiempo real y documentos de identidad (KYC de profesionales vía Stripe Connect).
6. **Términos de servicio / política de cancelación y reembolso** visibles dentro de la app antes de pagar — Apple lo exige explícitamente para apps con pagos a terceros gestionados fuera de Apple IAP (pagos de servicios físicos vía Stripe están permitidos, pero deben quedar claros los términos).
7. **`STRIPE_PUBLISHABLE_KEY` en el pipeline de build de producción** — hoy se inyecta vía `--dart-define` a mano (`defaultValue: ''`); si el build de release para las tiendas no la incluye, el Payment Sheet falla en producción. Verificar que el proceso de build de la store (Xcode Cloud / Codemagic / lo que se use) la inyecta correctamente con la clave **live**, no la de test.
8. **Auditar credenciales antes de publicar** — `backend_final_v3` loguea `JWT_SECRET` completo en consola (ya corregido en `backend_wizard`, ver Sprint 3 §3). Confirmar que ningún log de producción imprime secretos antes de que el backend quede expuesto públicamente con tráfico real.

## P1 — Importantes para un lanzamiento sólido (no bloquean el envío, pero sí la calidad/estabilidad)

9. **Resolver la deriva entre `backend_wizard` y `backend_final_v3`** — son el mismo proyecto con al menos 3 diferencias conocidas (fix de Stripe, cast de tipos JWT, log de secreto). Decidir cuál es la fuente de verdad y archivar/eliminar la otra antes de que alguien despliegue la copia equivocada.
10. **Notificaciones push** — marcadas como `TODO` en varios puntos del backend (aprobación/rechazo de verificación, etc.). Sin esto, profesionales y clientes no se enteran de eventos clave (solicitud aceptada, pago liberado) salvo que tengan la app abierta.
11. **Pantalla "buscando profesionales"** tras crear una solicitud — `TODO` en `home_cliente_screen.dart`. Hoy el cliente crea la solicitud sin feedback visual de que se está procesando.
12. **Suite de tests automatizados** — actualmente **no existe ningún test** en ninguno de los dos backends (sin script `test`, sin archivos `*.test.ts`), y el frontend solo tiene el `widget_test.dart` por defecto de Flutter. Priorizar:
    - Flujo de pago completo (regresión del bug corregido en Sprint 3).
    - Condición de carrera al aceptar una solicitud (`acceptServiceRequest`, ya mitigada con `updateMany` atómico pero sin test que lo confirme).
13. **CI básico** (lint + build en cada PR) — ya señalado como pendiente en el README, nunca implementado.
14. **Rate limiting y CORS de producción** — `cors({ origin: true })` acepta cualquier origen; revisar antes de exponer el backend con tráfico real y pagos.
15. **Monitorización/alertas de errores en producción** (Sentry o equivalente) — especialmente para fallos de liberación de pago (`releasePayment`), que hoy quedan en una "cola de reintento" manual sin alertar a nadie.

## P2 — Pulido posterior al lanzamiento

16. **Automatizar el reintento de pagos "colgados"** — cuando `releasePayment` falla, el servicio queda `completada` con el pago en `retenido` a la espera de reintento manual de un admin; construir un job que lo reintente solo.
17. **Onboarding de Stripe Connect embebido** en la app en vez de WebView externo al `onboardingUrl` — mejor UX de verificación para profesionales.
18. **Ficha de tienda** — capturas de pantalla, descripción localizada, categorización, clasificación de contenido/edad (ambas tiendas).
19. **Internacionalización** si se plantea expansión fuera de España (hoy los textos y `country: 'ES'` en Stripe Connect están hardcodeados a España).
20. **Login/registro sin Firebase como único punto de fallo** — evaluar fallback o mensaje claro si Firebase Auth no responde (hoy el arranque del backend depende de que `firebase-key.json`/credenciales estén siempre presentes, ver Sprint 3 §3).

---

## Nota sobre verificación en este entorno

`flutter analyze` (42 avisos, todos `info`, sin bloqueantes) y `flutter test` (1/1 pasa) se ejecutaron correctamente al cierre del Sprint 3 usando el SDK en `C:\Users\y_yon\Desktop\flutter_windows_3.44.8-stable\flutter`. Los 42 avisos de lint (sobre todo `withOpacity` deprecado) son un buen primer ítem de limpieza rápida al arrancar el Sprint 4, aunque no bloquean nada.
