import { Router } from 'express';
import { listCategories } from '../controllers/category.controller';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// Sin authMiddleware: el catálogo de categorías es público.
router.get('/', asyncHandler(listCategories));

export default router;
