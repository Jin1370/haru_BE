import { Request, Response, NextFunction } from 'express';

export function errorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // 클라이언트가 업로드 도중 연결을 끊은 경우 (multer "Request aborted").
  // 이미 소켓이 닫혀 있으므로 응답은 불필요. Sentry 전송도 생략하되,
  // 빈도 급증(UX 문제 신호) 감지를 위해 Fly 로그에는 남긴다.
  if (err.message === 'Request aborted') {
    console.info('[upload] client disconnected during multipart upload');
    return;
  }

  console.error('[Error]', err.message);

  res.status(500).json({ error: 'Internal server error' });
}
