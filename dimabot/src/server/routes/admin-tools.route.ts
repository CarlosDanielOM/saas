import express, { type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { readFile } from "../../utils/fs.js";

const router = express.Router();

// Only allow specific safe directories
const ALLOWED_BASE_PATHS = ['/home/cdom/saas/dimabot', '/home/cdom/saas/admin'];

function isPathAllowed(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    return ALLOWED_BASE_PATHS.some(base => normalizedPath.startsWith(base));
}

router.get('/read-file', authMiddleware as any, async (req: Request, res: Response) => {
    try {
        const filePath = req.query.path as string;

        if (!filePath) {
            return res.status(400).json({
                error: true,
                message: 'Missing path parameter',
                status: 400
            });
        }

        if (!isPathAllowed(filePath)) {
            return res.status(403).json({
                error: true,
                message: 'Path not allowed. Must be within /home/cdom/saas/dimabot or /home/cdom/saas/admin',
                status: 403
            });
        }

        const content = await readFile(filePath);

        return res.status(200).json({
            error: false,
            message: 'File read successfully',
            status: 200,
            data: {
                content,
                path: filePath
            }
        });

    } catch (error) {
        console.error('Error in GET /admin/read-file:', {
            path: req.query.path,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: error instanceof Error ? error.message : 'Failed to read file',
            status: 500
        });
    }
});

export const adminToolsRoute = router;