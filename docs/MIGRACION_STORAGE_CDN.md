# Migración de /uploads a Storage + CDN (preparado, NO activado)

Estado actual (2026-08-03): las imágenes (fotos de solicitud/perfil, disputas,
documentos de verificación) se guardan en disco local, en el Persistent Disk
de Render montado en `uploads/` (ver `src/config/upload.ts`), y se sirven
como estático desde `index.ts` (`app.use('/uploads', express.static(...))`).
Desde el bloque de rendimiento del 2026-08-03 se redimensionan/recomprimen
con `sharp` antes de guardarse (ver `upload.controller.ts`) — esto por sí
solo ya reduce mucho el problema de tamaño, pero no resuelve dos límites
estructurales:

1. **Un único disco de un único servidor no escala.** Si el backend pasa a
   tener más de una instancia (autoscaling horizontal), cada instancia
   tendría su propio disco — una foto subida a través de la instancia A no
   existiría en la B. Esto no es un problema hoy (una sola instancia,
   plan Starter) pero bloquea escalar horizontalmente sin antes resolver
   el almacenamiento.
2. **Sin CDN, cada imagen se sirve directamente desde el mismo proceso Node
   que atiende la API** — no hay caché de borde, cada visita a una foto es
   una petición más compitiendo por la misma CPU/ancho de banda del
   servicio (0.5 CPU en el plan Starter).

## Por qué no se activa todavía

El usuario pidió explícitamente dejar esto preparado pero NO activar ningún
plan de pago ni servicio nuevo hasta unos días antes de publicar en Google
Play. Tanto Supabase Storage como Firebase Storage tienen niveles gratuitos
que cubren de sobra el volumen actual de la beta, así que activarlo no
tiene coste añadido — pero es un cambio de infraestructura real (mover
archivos existentes, cambiar URLs ya guardadas en la base de datos) que
conviene hacer una sola vez, cerca del lanzamipiento, no dos veces.

## Opción recomendada: Supabase Storage

Ya se paga (en el sentido de que ya está aprovisionado) el proyecto de
Supabase que aloja la base de datos — Storage es un producto más del mismo
proyecto, sin credenciales nuevas que gestionar, y su nivel gratuito incluye
1GB + ancho de banda razonable. Tiene CDN propio delante de los objetos
públicos automáticamente (Supabase sirve los buckets públicos vía su CDN
global, sin configuración extra).

Alternativa descartada por ahora: Firebase Storage (el proyecto ya está en
plan Blaze, así que tampoco tendría coste de activación) — se prefiere
Supabase Storage para mantener un único proveedor para datos (Postgres +
archivos), en vez de repartir el estado entre Supabase y Firebase.

## Plan de migración paso a paso (para cuando se decida activarlo)

1. **Crear el bucket** en Supabase Dashboard → Storage → New bucket
   (público, ya que las fotos de perfil/solicitud se sirven sin auth hoy).
   Los documentos de verificación (`documentoIdentidadUrl`, `certificadosUrl`,
   `seguroRcUrl`) son más sensibles — valorar un bucket PRIVADO aparte con
   URLs firmadas de corta duración, ya que hoy se sirven igual de público
   que cualquier otra foto (nadie debería poder ver el DNI de un
   profesional solo con la URL).

2. **Añadir el SDK**: `npm install @supabase/supabase-js` en `backend_wizard`.
   Nuevas env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (ya
   disponibles en Supabase Dashboard → Settings → API — mismo proyecto que
   `DATABASE_URL`, no hay que crear nada).

3. **Cambiar `uploadPhoto`** (`src/controllers/upload.controller.ts`): en vez
   de `fs.writeFile(rutaDestino, buffer)`, subir el buffer ya procesado por
   sharp con `supabase.storage.from('uploads').upload(nombreArchivo, buffer,
   { contentType: 'image/jpeg' })`, y devolver la URL pública que Supabase
   genera (`supabase.storage.from('uploads').getPublicUrl(nombreArchivo)`)
   en vez de `${appBaseUrl}/uploads/${nombreArchivo}`. El resto del
   controlador (redimensionado, compresión, validación) no cambia nada —
   solo el paso final de "dónde se guarda el resultado".

4. **Migrar los archivos ya existentes** (aunque hoy son solo 3, ~180KB —
   antes de lanzar habrá más): script puntual que lee `uploads/*` del disco
   de Render (vía Shell) y los sube uno a uno al bucket nuevo con el MISMO
   nombre de archivo, para no tener que tocar ninguna URL ya guardada en
   `fotoUrl`/`fotosUrls`/`documentoIdentidadUrl`/etc. — si el nombre de
   archivo coincide, esas columnas ni se enteran del cambio de proveedor.

5. **Cambiar las URLs ya guardadas en BD** (si el dominio de las URLs
   cambia, p. ej. de `hogarsos.es/uploads/x.jpg` a
   `xxxx.supabase.co/storage/v1/object/public/uploads/x.jpg`): un
   `UPDATE` masivo por tabla/columna reemplazando el prefijo antiguo por
   el nuevo. Alternativa que evita esto por completo: mantener
   `/uploads/:archivo` como ruta en el backend, pero que en vez de sevir el
   archivo con `express.static` haga un **redirect 302** a la URL real de
   Supabase Storage — cero cambios en la base de datos, coste de una
   redirección extra por imagen (insignificante).

6. **Quitar el disco persistente de Render** una vez confirmada la
   migración (ya no hace falta, ahorra el coste — pequeño — del disco
   adicional).

7. **CDN**: si en el futuro Supabase Storage no diera suficiente
   rendimiento de borde para el volumen real, capa adicional posible sin
   cambiar de proveedor de Storage: Cloudflare delante del dominio
   `hogarsos.es` (plan gratuito) cacheando `/uploads/*` — pero esto es un
   paso posterior, no necesario para el lanzamiento inicial.

## Qué NO hace falta cambiar

El frontend (Flutter) no necesita ningún cambio para esta migración: sigue
recibiendo `{ url: "..." }` de `POST /uploads/photo` y usando esa URL tal
cual (`CachedNetworkImage`, `Image.network`, etc.) — el cambio es
completamente interno al backend.
