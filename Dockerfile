# Fly.io deploy 용 — multi-stage build (작은 런타임 이미지).
#
# 빌드 단계: TypeScript → dist/ 컴파일.
# 런타임 단계: 컴파일 결과 + 프로덕션 의존성만. credentials/ 는 image 에 포함 안 함
#              (GOOGLE_APPLICATION_CREDENTIALS_JSON env 로 startup 에 /tmp 작성).

# ---------- Builder ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------- Runtime ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Supabase migrations 는 런타임에 안 씀 (CLI 로 별도 적용) — 이미지 제외.
# credentials/ 도 image 에 없음. env 의 GOOGLE_APPLICATION_CREDENTIALS_JSON 으로
# startup 시 tmpdir 에 작성됨 (src/config/env.ts 참조).

EXPOSE 3000

CMD ["node", "dist/index.js"]
