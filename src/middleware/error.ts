import { Request, Response, NextFunction } from 'express';

export function errorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // 클라이언트가 본문 전송 도중 연결을 끊은 경우.
  // multer 는 "Request aborted", body-parser/raw-body 는 "request aborted"(type
  // 'request.aborted') 로 서로 다른 문자열을 던진다. 둘 다 앱 백그라운드 전환/네트워크
  // 끊김이라 서버 결함이 아니므로 Sentry 전송 생략. 빈도 급증(UX 문제 신호) 감지를
  // 위해 Fly 로그에는 남긴다. 이미 소켓이 닫혀 있으므로 응답도 불필요.
  if (err.message.toLowerCase() === 'request aborted') {
    console.info('[request] client disconnected before body was fully received');
    return;
  }

  console.error('[Error]', err.message);

  res.status(500).json({ error: 'Internal server error' });
}
