import './net-ipv4'; // outbound DNS IPv4-first — Fly IPv6→googleapis egress fix (must precede any HTTPS)
import './instrument'; // Sentry init — 반드시 다른 import보다 먼저
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { authLimiter, waitlistLimiter } from './middleware/rateLimit';
import { swaggerDocument } from './swagger';
import { errorMiddleware } from './middleware/error';
import configRoutes from './routes/config';
import waitlistRoutes from './routes/waitlist';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import voiceRoutes from './routes/voice';
import swipeRoutes from './routes/swipe';
import matchRoutes from './routes/match';
import messageRoutes from './routes/message';
import blockRoutes from './routes/block';
import reportRoutes from './routes/report';
import preferenceRoutes from './routes/preference';
import notificationsRoutes from './routes/notifications';
import adminRoutes from './routes/admin';
import { startAudioExpiryScheduler } from './jobs/purgeExpiredAudio';
import { startAuditCleanupScheduler } from './jobs/cleanupAuditTables';
import { startPhotoConversionRetryScheduler } from './jobs/retryFailedPhotoConversions';

export const app = express();

// Fly.io 등 리버스 프록시 뒤에서 실제 클라이언트 IP 를 req.ip 로 인식하게 한다
// (단일 프록시 홉 신뢰). 이게 없으면 rate limit 이 모든 사용자를 프록시 IP 하나로
// 묶어 무력화된다. 값을 number(1)로 두는 이유: `true`(전체 신뢰)는 X-Forwarded-For
// 위조로 한도 우회가 가능해 express-rate-limit 이 경고하기 때문. 로컬(프록시 없음)
// 에선 XFF 헤더가 없어 socket IP 가 그대로 쓰여 무해.
app.set('trust proxy', 1);

// 보안 HTTP 헤더 — clickjacking(투명 iframe 덮어쓰기) / MIME sniffing(타입 추측
// 실행) / referrer 누수 등을 브라우저 차원에서 차단. cors 앞에 등록.
// CSP 는 비활성 — 이 BE 는 JSON API 이고 유일한 HTML 표면인 Swagger UI(/docs)의
// 인라인 스타일/스크립트를 깨지 않기 위함. CSP 도입은 별도 과제로 분리(JSON API 라
// 우선순위 낮음). prod /docs 게이트는 아래 Swagger mount 분기에서 처리(체크리스트 17).
// CORP 도 비활성 — admin/web 크로스오리진 소비는
// 아래 CORS 로 이미 제어하므로 same-origin CORP 가 그 경로를 막지 않게 한다.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// CORS — production 에서는 화이트리스트 strict, 개발 환경은 와이드 오픈 유지.
// CORS_ALLOWED_ORIGINS env 가 set 되어 있으면 콤마 분리 origin 만 허용.
// 모바일 앱(Expo native)은 browser 가 아니므로 CORS 영향 없음 — origin null 도 허용.
//
// glob 패턴 (* 와일드카드) 지원 — Vercel 의 deployment-specific URL 대응 위해.
//   예: 'https://haruadmin-*-sejin-ims-projects.vercel.app' 는
//       haruadmin-7rupppulw-sejin-ims-projects.vercel.app 등 매 배포 URL 매칭.
function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return regex.test(origin);
}

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// prod fail-closed (체크리스트 17) — CORS_ALLOWED_ORIGINS 미설정 시 "전체 허용"
// fallback 으로 조용히 넘어가지 않고 부팅을 막는다. 설정 누락을 즉시 노출해
// 아무 사이트나 API 를 호출하는 상태를 차단. dev/test(NODE_ENV !== production)는
// 아래 wide-open fallback 을 그대로 유지하므로 로컬 개발은 영향 없음.
if (allowedOrigins.length === 0 && env.nodeEnv === 'production') {
  throw new Error(
    'CORS_ALLOWED_ORIGINS must be set in production (fail-closed). ' +
      '콤마로 구분된 허용 origin 목록을 prod 환경변수에 설정하세요.',
  );
}

if (allowedOrigins.length > 0) {
  app.use(
    cors({
      origin: (origin, callback) => {
        // origin === undefined: 모바일 native / curl / 동일 출처 → 허용
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.some((p) => originMatches(origin, p))) {
          callback(null, true);
        } else {
          callback(new Error(`CORS blocked: ${origin}`));
        }
      },
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Admin-Secret',
        'X-Admin-Impersonate',
      ],
    }),
  );
  console.log(`[startup] CORS whitelist: ${allowedOrigins.join(', ')}`);
} else {
  // 로컬 개발/테스트 — 전체 허용 (CORS_ALLOWED_ORIGINS 미설정 시).
  app.use(cors());
}

app.use(express.json());

// Swagger (/docs) — API 설명서(HTML). prod 에선 서버 구조·엔드포인트 노출을 막기
// 위해 mount 자체를 생략한다 (체크리스트 17). dev/test 는 그대로 열려 개발에 무영향.
// prod 에서 일시 확인이 필요하면 NODE_ENV 를 바꾸지 말고 별도 시크릿 게이트를 후속 도입.
if (env.nodeEnv !== 'production') {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} else {
  console.log('[startup] Swagger /docs disabled in production');
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Routes
// 강제 업데이트 게이트 — 인증 불필요. authMiddleware 없는 router 라 부팅 시
// 로그인 전에도 호출 가능 (옛 앱이 BE 와 통신하기 전에 차단되도록).
app.use('/api/config', configRoutes);
// 랜딩페이지 출시 대기자 모집 폼 — 인증 불필요한 공개 라우트 (가입 전 방문자).
// waitlistLimiter: 무작위 이메일 대량 제출로 인한 무한 row 증식 차단.
app.use('/api/waitlist', waitlistLimiter, waitlistRoutes);
// authLimiter: credential stuffing(유출 비번 대량 시도) 차단.
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/discover', swipeRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/matches', messageRoutes);
app.use('/api/block', blockRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/preferences', preferenceRoutes);
app.use('/api/notifications', notificationsRoutes);

// dev/QA 어드민 라우트 — env.admin.dashboardEnabled=true 일 때만 mount.
// 출시 빌드에선 ADMIN_DASHBOARD_ENABLED 미설정 → 라우트 자체가 부재.
if (env.admin.dashboardEnabled) {
  app.use('/api/admin', adminRoutes);
  console.warn('[startup] /api/admin mounted (ADMIN_DASHBOARD_ENABLED=true). 출시 빌드에서는 disable 필수.');
}

// Error handling — Sentry 핸들러를 커스텀 errorMiddleware "앞"에 등록해야
// 모든 라우트 에러를 캡처한 뒤 errorMiddleware 가 응답을 내려준다.
Sentry.setupExpressErrorHandler(app);
app.use(errorMiddleware);

if (process.env.NODE_ENV !== 'test') {
  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });
  // audio-expiry sprint: 청취 완료 + 30일 경과 음성 파일 일일 sweep 등록.
  // NODE_ENV=test 분기는 scheduler 내부에서도 가드되지만, listen 과 함께 묶어
  // 부팅 sequence 를 단일 위치로 유지.
  startAudioExpiryScheduler();
  // audit-cleanup sprint: moderation_blocks / freeze_events 365일 보관 정책
  // (PIPA §21 + GDPR Art.5(1)(e) data minimization). 같은 24h interval + unref 패턴.
  startAuditCleanupScheduler();
  // photo-watercolor-pipeline sprint: pending/failed 사진 변환 재시도 sweep.
  // 부팅 120s 후 1회 + 10 분 interval. 백필 row 처리 + transient 실패 자동 복구.
  startPhotoConversionRetryScheduler();
}
