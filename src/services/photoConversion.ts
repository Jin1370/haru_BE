// photo-watercolor-pipeline sprint — gpt-image-2 변환 서비스.
//
// 사진별 변환 lifecycle (profile_photos.status):
//   pending (신규 row, 또는 백필 row — 변환 미시작)
//     → processing (OpenAI 호출 중)
//       → ready (변환 + Storage 업로드 + 원본 폐기 완료)
//       → failed (네트워크/타임아웃/5xx — retry sweep 이 자동 재시도)
//       → rejected (OpenAI safety filter 거부 — 재시도 불가, 사용자 재업로드)
//
// 원본 폐기 정책: 변환 성공 직후 즉시 폐기 (voice-sample-removal sprint 의 "운영상
// 사용처 0" 패턴). 변환 실패 시 원본 보존 → retry sweep 이 재호출.
//
// silent-success 룰 (CLAUDE.md):
//   * OpenAI / Supabase / Storage 모든 호출 결과 error 명시 destructure + console.error.
//   * fire-and-forget 도 `.then(({error}) => ...)` 패턴.
//
// 백필 사진 (original_path 가 Storage path 가 아니라 public URL) 처리:
//   * URL → fetch bytes → toFile → gpt-image-2 → 변환본 업로드 → status='ready'.
//   * 변환 후 원본 URL 의 Storage path 도 cleanup 가능 (extractPath 로 추출 시도,
//     실패하면 skip — 백필 URL 이 외부 Storage 일 가능성 0 이지만 방어적).

import OpenAI, { toFile } from 'openai';
import Jimp from 'jimp';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { uploadFile, deleteFile, extractPath } from './storage';
import { logModerationBlock } from '../utils/moderationAudit';
import type { ModerationBlockEvent } from '../utils/moderationAudit';
import {
  WATERCOLOR_PROMPT,
  PHOTO_CONVERSION_MODEL,
  PHOTO_CONVERSION_SIZE,
  PHOTO_CONVERSION_QUALITY,
  PHOTO_CONVERSION_OUTPUT_FORMAT,
  PHOTO_CONVERSION_OUTPUT_COMPRESSION,
  PHOTO_CONVERSION_INPUT_MAX_WIDTH,
  PHOTO_CONVERSION_INPUT_MAX_HEIGHT,
} from '../constants/photoConversion';

// 변환 입력 사진을 출력 해상도(768x1024) 박스로 다운스케일 — 원본이 더 클 때만.
// gpt-image-2 입력 이미지 토큰(비용 ~80%)을 절감. 비율 유지, 업스케일 안 함.
// jimp 디코드 실패(손상/미지원 포맷 등) 시 원본 그대로 폴백 — 리사이즈 실패가
// 변환 자체를 막지 않게 한다.
async function downscaleForConversion(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const image = await Jimp.read(buffer);
    if (
      image.bitmap.width > PHOTO_CONVERSION_INPUT_MAX_WIDTH ||
      image.bitmap.height > PHOTO_CONVERSION_INPUT_MAX_HEIGHT
    ) {
      image.scaleToFit(PHOTO_CONVERSION_INPUT_MAX_WIDTH, PHOTO_CONVERSION_INPUT_MAX_HEIGHT);
      const resized = await image.getBufferAsync(Jimp.MIME_JPEG);
      return { buffer: resized, mimeType: 'image/jpeg' };
    }
  } catch (e) {
    console.warn('[photoConversion.resize_skipped]', (e as Error).message);
  }
  return { buffer, mimeType };
}

// SDK 클라이언트는 module top-level lazy init — env 미설정 시 null.
// 우선순위: Azure OpenAI(APIM) 설정이 있으면 그쪽으로 구성, 없으면 OpenAI 직접
// (openaiModeration.ts 와 동일한 `OPENAI_API_KEY` 재사용) fallback.
// Azure 경유: baseURL = .../deployments/<name> (경로에 /openai 없음 — APIM 매핑),
// 인증은 `api-key` 헤더, `api-version` 쿼리. SDK 가 함께 보내는 Authorization Bearer 는
// APIM 이 무시하므로 충돌 없음 (라이브 검증 완료). `images.edit` 호출부는 무변경 —
// 클라이언트 구성만 바뀌므로 vi.mock('openai') 기반 단위 테스트도 그대로 통과.
let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (client) return client;
  if (env.image.azureBaseUrl && env.image.azureApiKey) {
    client = new OpenAI({
      apiKey: env.image.azureApiKey,
      baseURL: env.image.azureBaseUrl,
      defaultQuery: { 'api-version': env.image.azureApiVersion },
      defaultHeaders: { 'api-key': env.image.azureApiKey },
    });
    // 어떤 provider 가 실제 활성화됐는지 가시화 — 배포 env 에 AZURE_IMAGE_* 누락 시
    // 조용히 OpenAI 로 폴백하는 상황을 부팅 로그(첫 변환 시점)에서 잡기 위함.
    console.log('[photoConversion] image provider = Azure OpenAI (APIM):', env.image.azureBaseUrl);
    return client;
  }
  if (env.openai.moderationApiKey) {
    console.warn(
      '[photoConversion] image provider = OpenAI direct (fallback) — AZURE_IMAGE_BASE_URL/AZURE_IMAGE_API_KEY 미설정',
    );
    client = new OpenAI({ apiKey: env.openai.moderationApiKey });
    return client;
  }
  return null;
}

export interface ConversionInput {
  userId: string;
  photoRowId: string;
  originalBuffer: Buffer;
  mimeType: string;
  // 원본의 Storage path (cleanup 용). 백필 row 는 URL 인 경우가 있어 nullable.
  // 변환 성공 후 path 가 있으면 Storage 에서 delete.
  originalPath?: string | null;
}

export type ConversionStatus = 'ready' | 'failed' | 'rejected';

export interface ConversionResult {
  status: ConversionStatus;
  convertedUrl?: string;
  failureReason?: string;
  rejectedCategory?: ModerationBlockEvent['category'];
  rejectedRawCategory?: string;
}

// OpenAI safety filter 거부 감지. gpt-image-2 의 응답 형태:
//   * HTTP 400 + error.code='moderation_blocked' (또는 유사) 가 가장 흔함.
//   * 응답 메시지에 'safety system' / 'content policy' / 'moderation' 등 키워드 포함.
//
// OpenAI 응답 카테고리 추출: gpt-image-2 가 거부 카테고리를 명시 반환하는 표준 필드가
// 없으므로 (image moderation 은 text moderation 과 응답 shape 다름) error.message
// 기반 heuristic + 'photo_generic' 폴백.
function detectModerationRejection(err: unknown): {
  rejected: boolean;
  category: ModerationBlockEvent['category'];
  rawCategory?: string;
} {
  const errAny = err as { status?: number; code?: string; message?: string; error?: { code?: string; message?: string } };
  const status = errAny.status;
  const code = errAny.code ?? errAny.error?.code;
  const message = (errAny.message ?? errAny.error?.message ?? '').toLowerCase();

  const codeIsModeration =
    code === 'moderation_blocked' ||
    code === 'content_policy_violation' ||
    code === 'content_filter' || // Azure OpenAI content filter
    code === 'image_generation_user_error';

  const messageIsModeration =
    message.includes('safety system') ||
    message.includes('content policy') ||
    message.includes('content management policy') || // Azure OpenAI wording
    message.includes('moderation') ||
    message.includes('safety filter');

  if (!codeIsModeration && !(status === 400 && messageIsModeration)) {
    return { rejected: false, category: 'sexual' };
  }

  // 카테고리 추출 heuristic — message 본문에서 키워드 매칭. 매칭 실패 시 'sexual'
  // 폴백 (gpt-image-2 거부 사유의 통계적 최빈값). audit 정밀도가 떨어지지만 차단
  // 자체의 정합성은 영향 없음.
  let category: ModerationBlockEvent['category'] = 'sexual';
  if (message.includes('minor') || message.includes('child') || message.includes('underage')) {
    category = 'minor';
  } else if (message.includes('self-harm') || message.includes('self harm')) {
    category = 'self_harm';
  } else if (message.includes('drug') || message.includes('illicit')) {
    category = 'drug';
  }

  return { rejected: true, category, rawCategory: code ?? 'gpt-image-2:safety_filter' };
}

// 백필 row 처리: original_path 가 'http(s)://' 로 시작하면 URL 로 간주 → fetch.
// 변환 성공 후 cleanup 시에도 URL 의 Storage path 추출 시도.
async function downloadOriginalBytes(originalPath: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  if (originalPath.startsWith('http://') || originalPath.startsWith('https://')) {
    const res = await fetch(originalPath);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
    return { buffer: Buffer.from(ab), mimeType };
  }

  // Storage path. signed URL 우회: download 메서드 사용.
  const { data, error } = await supabase.storage.from('photos').download(originalPath);
  if (error || !data) {
    throw new Error(`Storage download failed: ${error?.message ?? 'no data'}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  return { buffer, mimeType: data.type || 'image/jpeg' };
}

// profile_photos UPDATE 헬퍼 — silent-success 룰 적용.
async function updatePhotoStatus(
  photoRowId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('profile_photos')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', photoRowId);
  if (error) {
    console.error('[photoConversion.update_status_failed]', {
      photo_row_id: photoRowId,
      patch_keys: Object.keys(patch),
      error: error.message,
    });
  }
}

// 핵심 변환 함수. 비동기 호출 — 호출처는 .catch() 로만 결과 흡수.
export async function convertProfilePhoto(input: ConversionInput): Promise<ConversionResult> {
  const { userId, photoRowId, originalBuffer, mimeType, originalPath } = input;

  // status='processing' 으로 전이 — 동시 sweep 워커가 같은 row 잡지 않도록 가드.
  await updatePhotoStatus(photoRowId, { status: 'processing' });

  const c = getClient();
  if (!c) {
    const failureReason = 'openai_key_missing';
    await updatePhotoStatus(photoRowId, { status: 'failed', failure_reason: failureReason });
    console.error('[photoConversion.openai_key_missing]', { user_id: userId, photo_row_id: photoRowId });
    return { status: 'failed', failureReason };
  }

  // gpt-image-2 호출. SDK 의 ImageEditParamsNonStreaming 시그니처 정합.
  let b64: string | undefined;
  try {
    // 변환 직전 입력 사진을 768x1024 박스로 다운스케일 (입력 토큰 절감).
    const downscaled = await downscaleForConversion(originalBuffer, mimeType);
    const file = await toFile(
      downscaled.buffer,
      `original-${photoRowId}.${mimeTypeToExt(downscaled.mimeType)}`,
      { type: downscaled.mimeType },
    );
    const response = await c.images.edit({
      model: PHOTO_CONVERSION_MODEL,
      image: file,
      prompt: WATERCOLOR_PROMPT,
      size: PHOTO_CONVERSION_SIZE,
      quality: PHOTO_CONVERSION_QUALITY,
      output_format: PHOTO_CONVERSION_OUTPUT_FORMAT,
      output_compression: PHOTO_CONVERSION_OUTPUT_COMPRESSION,
      user: userId,
      n: 1,
    });
    // gpt-image models always return b64_json (response_format 무시).
    b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('gpt-image-2 returned empty response data');
    }
  } catch (err) {
    const rejection = detectModerationRejection(err);
    if (rejection.rejected) {
      // 모더레이션 거부 — status='rejected' + audit + 원본 폐기 (재시도 불가).
      logModerationBlock({
        senderId: userId,
        category: rejection.category,
        language: 'unknown',
        layer: 'openai',
        surface: 'photo',
        rawCategory: rejection.rawCategory,
      });
      await updatePhotoStatus(photoRowId, {
        status: 'rejected',
        failure_reason: 'moderation_rejected',
        original_path: null,
      });
      // 원본 Storage cleanup (Storage path 인 경우만). 백필 URL 은 skip.
      if (originalPath && !originalPath.startsWith('http')) {
        deleteFile('photos', originalPath).catch((e) =>
          console.error('[photoConversion.cleanup_rejected_failed]', {
            user_id: userId,
            path: originalPath,
            error: (e as Error).message,
          }),
        );
      }
      console.warn('[photoConversion.rejected]', {
        user_id: userId,
        photo_row_id: photoRowId,
        category: rejection.category,
        raw_category: rejection.rawCategory,
      });
      return {
        status: 'rejected',
        failureReason: 'moderation_rejected',
        rejectedCategory: rejection.category,
        rejectedRawCategory: rejection.rawCategory,
      };
    }

    // 네트워크/타임아웃/5xx — status='failed' + retry_count 증가.
    const errAny = err as { message?: string };
    const failureReason = inferFailureReason(errAny.message ?? '');
    console.error('[photoConversion.openai_error]', {
      user_id: userId,
      photo_row_id: photoRowId,
      failure_reason: failureReason,
      message: errAny.message,
    });
    await markFailedWithRetryIncrement(photoRowId, failureReason);
    return { status: 'failed', failureReason };
  }

  // 변환 성공 — Storage 업로드.
  let convertedUrl: string;
  try {
    const buffer = Buffer.from(b64, 'base64');
    // output_format='jpeg' + compression 85 (constants/photoConversion.ts).
    // versioned path 로 캐시 충돌 회피.
    const ts = Date.now();
    const ext = PHOTO_CONVERSION_OUTPUT_FORMAT === 'jpeg' ? 'jpg' : PHOTO_CONVERSION_OUTPUT_FORMAT;
    const mime = PHOTO_CONVERSION_OUTPUT_FORMAT === 'jpeg' ? 'image/jpeg' : `image/${PHOTO_CONVERSION_OUTPUT_FORMAT}`;
    const path = `${userId}/converted/${photoRowId}_v${ts}.${ext}`;
    convertedUrl = await uploadFile('photos', path, buffer, mime);
  } catch (err) {
    const message = (err as Error).message;
    console.error('[photoConversion.upload_failed]', {
      user_id: userId,
      photo_row_id: photoRowId,
      error: message,
    });
    await markFailedWithRetryIncrement(photoRowId, 'upload_failed');
    return { status: 'failed', failureReason: 'upload_failed' };
  }

  // DB UPDATE — status='ready' + converted_url + original_path 폐기 표시.
  await updatePhotoStatus(photoRowId, {
    status: 'ready',
    converted_url: convertedUrl,
    original_path: null,
    failure_reason: null,
  });

  // 원본 Storage 폐기 (fire-and-forget — DB UPDATE 가 이미 성공하여 사용자 영향 0).
  // 백필 URL (http(s)://) 은 같은 Storage path 일 수 있어 extractPath 시도 → 실패하면 skip.
  if (originalPath) {
    let pathToDelete: string | null = null;
    if (originalPath.startsWith('http://') || originalPath.startsWith('https://')) {
      try {
        pathToDelete = extractPath('photos', originalPath);
      } catch {
        // 외부 Storage URL 또는 비표준 포맷 — skip.
        pathToDelete = null;
      }
    } else {
      pathToDelete = originalPath;
    }
    if (pathToDelete) {
      const p = pathToDelete;
      deleteFile('photos', p).catch((e) =>
        console.error('[photoConversion.cleanup_original_failed]', {
          user_id: userId,
          path: p,
          error: (e as Error).message,
        }),
      );
    }
  }

  console.log('[photoConversion.ready]', {
    user_id: userId,
    photo_row_id: photoRowId,
  });

  return { status: 'ready', convertedUrl };
}

// retry sweep 이 호출하는 함수 — 원본 bytes 가 없으므로 download 분기.
export async function retryPendingOrFailedPhoto(
  userId: string,
  photoRowId: string,
  originalPath: string,
): Promise<ConversionResult> {
  let buffer: Buffer;
  let mimeType: string;
  try {
    const r = await downloadOriginalBytes(originalPath);
    buffer = r.buffer;
    mimeType = r.mimeType;
  } catch (err) {
    const message = (err as Error).message;
    console.error('[photoConversion.retry_download_failed]', {
      user_id: userId,
      photo_row_id: photoRowId,
      path: originalPath,
      error: message,
    });
    await markFailedWithRetryIncrement(photoRowId, 'download_failed');
    return { status: 'failed', failureReason: 'download_failed' };
  }

  return convertProfilePhoto({
    userId,
    photoRowId,
    originalBuffer: buffer,
    mimeType,
    originalPath,
  });
}

function mimeTypeToExt(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

// status='failed' 마킹 + retry_count 증가 (openai/upload/download 3 실패 경로 공용).
// retry_count 증가는 별도 SELECT 후 UPDATE. supabase-js v2 의 raw SQL increment
// 미지원이라 atomic 증가는 단순 SELECT-then-UPDATE (race 시 약간의 over-count
// 발생 가능하나 max=3 cap 으로 영향 무시).
async function markFailedWithRetryIncrement(
  photoRowId: string,
  failureReason: string,
): Promise<void> {
  const { data: cur } = await supabase
    .from('profile_photos')
    .select('retry_count')
    .eq('id', photoRowId)
    .maybeSingle();
  const newRetryCount = ((cur?.retry_count as number | null) ?? 0) + 1;
  await updatePhotoStatus(photoRowId, {
    status: 'failed',
    failure_reason: failureReason,
    retry_count: newRetryCount,
  });
}

function inferFailureReason(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) return 'openai_timeout';
  if (m.includes('network') || m.includes('econnreset') || m.includes('fetch failed')) return 'network';
  return 'openai_error';
}
