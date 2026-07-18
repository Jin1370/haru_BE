import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

function handleParseError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ZodError) {
    const message = err.issues.map((e) => `${String(e.path.join('.'))}: ${e.message}`).join(', ');
    res.status(400).json({ error: message });
    return;
  }
  next(err);
}

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      handleParseError(err, _res, next);
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.query);
      // Express 5에서 req.query는 getter 전용이므로 Object.defineProperty로 덮어씀
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      next();
    } catch (err) {
      handleParseError(err, _res, next);
    }
  };
}
