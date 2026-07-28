-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('cliente', 'profesional', 'admin');

-- CreateEnum
CREATE TYPE "EstadoVerificacion" AS ENUM ('pendiente', 'aprobado', 'rechazado');

-- CreateEnum
CREATE TYPE "EstadoSolicitud" AS ENUM ('pendiente', 'aceptada', 'en_progreso', 'completada', 'cancelada', 'disputada');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('retenido', 'liberado', 'reembolsado', 'fallido');

-- CreateEnum
CREATE TYPE "UrgenciaSolicitud" AS ENUM ('lo_antes_posible', 'hoy', 'manana', 'fecha_especifica');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "telefono" TEXT,
    "nombre" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'cliente',
    "firebase_uid" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "icono_url" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professionals" (
    "user_id" TEXT NOT NULL,
    "documento_identidad_url" TEXT NOT NULL,
    "certificados_url" TEXT[],
    "seguro_rc_url" TEXT,
    "estado_verificacion" "EstadoVerificacion" NOT NULL DEFAULT 'pendiente',
    "tarifa_base" DECIMAL(65,30) NOT NULL,
    "valoracion_media" DECIMAL(65,30) NOT NULL DEFAULT 0.00,
    "total_trabajos" INTEGER NOT NULL DEFAULT 0,
    "disponible" BOOLEAN NOT NULL DEFAULT false,
    "stripe_account_id" TEXT,
    "verificado_por" TEXT,
    "verificado_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "zonaTrabajo" geography(Polygon, 4326),
    "ubicacionActual" geography(Point, 4326),

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "professional_categories" (
    "professional_id" TEXT NOT NULL,
    "category_id" INTEGER NOT NULL,

    CONSTRAINT "professional_categories_pkey" PRIMARY KEY ("professional_id","category_id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "cliente_id" TEXT NOT NULL,
    "profesional_id" TEXT,
    "category_id" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "foto_url" TEXT,
    "fotos_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ubicacion" geography(Point, 4326) NOT NULL,
    "direccion_texto" TEXT,
    "urgencia" "UrgenciaSolicitud" NOT NULL DEFAULT 'lo_antes_posible',
    "fecha_deseada" TIMESTAMP(3),
    "precio_estimado" DECIMAL(65,30),
    "precio_final" DECIMAL(65,30),
    "estado" "EstadoSolicitud" NOT NULL DEFAULT 'pendiente',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aceptada_at" TIMESTAMP(3),
    "completada_at" TIMESTAMP(3),

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "monto_total" DECIMAL(65,30) NOT NULL,
    "comision_plataforma" DECIMAL(65,30) NOT NULL,
    "monto_profesional" DECIMAL(65,30) NOT NULL,
    "estado" "EstadoPago" NOT NULL DEFAULT 'retenido',
    "stripe_payment_intent_id" TEXT,
    "stripe_transfer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liberado_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "autor_id" TEXT NOT NULL,
    "destinatario_id" TEXT NOT NULL,
    "puntuacion" INTEGER NOT NULL,
    "comentario" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "service_request_id" TEXT NOT NULL,
    "creado_por" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'abierta',
    "resuelto_por" TEXT,
    "resolucion_notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_nombre_key" ON "service_categories"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "payments_service_request_id_key" ON "payments"("service_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_key" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_service_request_id_key" ON "reviews"("service_request_id");

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_categories" ADD CONSTRAINT "professional_categories_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_categories" ADD CONSTRAINT "professional_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_profesional_id_fkey" FOREIGN KEY ("profesional_id") REFERENCES "professionals"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_autor_id_fkey" FOREIGN KEY ("autor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_destinatario_id_fkey" FOREIGN KEY ("destinatario_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
