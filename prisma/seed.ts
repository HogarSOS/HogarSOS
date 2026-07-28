import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Catálogo de categorías de hogarSOS.
 *
 * El campo `nombre` es el nombre CANÓNICO (en español) que vive en la
 * base de datos — es lo que usan las relaciones (professional_categories,
 * service_requests) y lo que devuelve la API. La traducción a otros
 * idiomas (incluido el inglés) NO vive aquí, vive en el frontend
 * (lib/l10n/*.arb + lib/utils/category_display.dart), que traduce por
 * nombre. Esto evita tener que tocar el esquema de la base de datos
 * para soportar idiomas — el nombre canónico es solo una clave interna,
 * el usuario nunca ve directamente este string en inglés.
 *
 * Añadir una categoría nueva en el futuro: una línea aquí + una entrada
 * en category_display.dart (icono, color) + una clave en los .arb.
 */
const CATEGORIAS = [
  'Electricista',
  'Fontanero',
  'Pintor',
  'Manitas',
  'Limpieza',
  'Jardinería',
  'Cerrajería',
  'Reformas',
  'Aire acondicionado',
  'Carpintería',
  'Albañilería',
  'Tejados y cubiertas',
  'Cristalería',
  'Carpintería metálica',
  'Antenas y telecomunicaciones',
  'Sistemas de seguridad',
  'Mudanzas',
  'Limpieza de cristales',
  'Piscinas',
  'Control de plagas',
  'Veterinaria a domicilio',
];

async function main() {
  for (const nombre of CATEGORIAS) {
    await prisma.serviceCategory.upsert({
      where: { nombre },
      update: {}, // si ya existe, no se toca (idempotente — se puede re-ejecutar sin duplicar ni pisar cambios manuales)
      create: { nombre, activo: true },
    });
  }

  const total = await prisma.serviceCategory.count();
  console.log(`Seed de categorías completado. Total de categorías activas en BD: ${total}`);
}

main()
  .catch((e) => {
    console.error('Error al sembrar categorías:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
