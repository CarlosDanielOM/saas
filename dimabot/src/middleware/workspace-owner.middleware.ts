import type { NextFunction, Request, Response } from 'express';

/** Internal workspace tools require the same account as the Admin whitelist. */
export function workspaceOwnerMiddleware(req: Request, res: Response, next: NextFunction): void {
    const identity = (req as Request & { user?: { id: string } }).user;
    if (identity?.id !== '533538623') {
        res.status(403).json({ error: true, message: 'Admin workspace access required', status: 403 });
        return;
    }
    next();
}
