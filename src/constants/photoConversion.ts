// photo-watercolor-pipeline sprint — gpt-image-2 변환 상수.
//
// 모델 선택: gpt-image-2 (메모리 project-image-pipeline-model 2026-05-22 사용자 실증).
// 응답 형식: GPT image models always return base64-encoded images.
// 사이즈: 1024x1024 (정사각형 프로필 카드 정합).
// input_fidelity: SDK 타입엔 명시되어 있지만 gpt-image-2 가 런타임에 400 으로 거부 (2026-05-27 실측).
//   gpt-image-1.5 부터 지원되는 옵션으로 추정 — 향후 모델 업그레이드 시 재도입 검토.
//
// 프롬프트 룰:
//   (1) 차별점 4 의 톤 = 한국 manhwa + 일본 anime/niji + 디즈니 수채화 컨셉 아트 융합.
//   (2) safety pre-check §E 의 보존 룰:
//       - 얼굴 구조 / 나이 / 성별 / 인종 보존
//       - 피부톤 / 눈 모양 / 머리카락 텍스처 / 인종 표식 정확히 보존
//       - 종교/문화 표식 (hijab, turban, kippah, cross necklace, bindi 등) 정확히 보존
//       - 배경 객체 (gym equipment, room interior, cafe, nature, vehicles, signs) 보존
//       - 의상 스타일 / 색 실루엣 보존
//   (3) safety pre-check §E 의 STRICT EXCLUSIONS:
//       - 명명된 캐릭터 likeness 금지 (Rapunzel, Anna, Mirabel 등)
//       - 텍스트 / 캡션 / 서명 / 워터마크 / 말풍선 금지
//       - 외관 나이 변경 금지 (aging-up / aging-down)
//       - 체형 / 인종 변경 금지

export const WATERCOLOR_PROMPT = `Transform this portrait into a stylized character illustration that
blends Korean manhwa, Japanese anime/niji, and Disney watercolor concept art.
Use soft watercolor textures with ink linework and warm color palette.

CRITICAL PRESERVATION RULES:
- Preserve the subject's facial structure, age, gender, and ethnicity exactly as in the original.
- Preserve skin tone, eye shape, hair texture, and ethnicity markers exactly as in source.
- Preserve all background objects (gym equipment, room interior, cafe, nature, vehicles,
  signs) as recognizable watercolor renderings — do not blank or simplify the background.
- Preserve religious or cultural items including hijab, turban, yarmulke/kippah, cross necklace,
  bindi, and similar identity markers exactly as in the original.
- Preserve clothing style and color silhouette.
- Preserve eyeglasses, jewelry, and visible accessories.

STRICT EXCLUSIONS:
- Do NOT use named character likenesses (no Rapunzel, Anna, Mirabel, Elsa, etc.).
- Do NOT add text, captions, signatures, watermarks, or speech bubbles.
- Do NOT change apparent age (no aging-up or aging-down).
- Do NOT change body proportions or ethnicity.`;

// 모델 ID — OpenAI SDK ImageModel enum 의 'gpt-image-2' (node_modules/openai/resources/images.d.ts:310).
export const PHOTO_CONVERSION_MODEL = 'gpt-image-2' as const;

// 출력 사이즈. 768x1024 = 3:4 portrait (디스커버 카드 정합 + 모바일 해상도 충분).
// gpt-image-2 arbitrary size 지원 — 16 divisible + 1:3~3:1 비율 범위 내.
// 1024x1024 대비 75% pixel 수 → 토큰 사용량 ~75% (quality='low' 와 결합 시 가장 저렴).
export const PHOTO_CONVERSION_SIZE = '768x1024' as const;

// 변환 입력 사진 다운스케일 상한. gpt-image-2 비용의 ~80% 는 *입력 이미지 토큰*
// 이고 그건 입력 해상도에 좌우된다. 출력이 768x1024 이므로 입력을 그보다 크게
// 보낼 이유가 없다(OpenAI 가 내부 다운스케일하므로 초과분은 토큰 낭비). 변환 직전
// 원본이 이 박스보다 클 때만 비율 유지 축소(작으면 그대로 — 업스케일 안 함).
export const PHOTO_CONVERSION_INPUT_MAX_WIDTH = 768;
export const PHOTO_CONVERSION_INPUT_MAX_HEIGHT = 1024;

// 변환 품질. 'low' = 가장 저렴 (~$0.005~0.01/장), 디스커버 카드 노출 해상도에 충분.
// 'medium'/'high'/'auto' 는 비용 2~4 배 증가. 출시 후 만족도 데이터 보고 'medium' 검토.
export const PHOTO_CONVERSION_QUALITY = 'low' as const;

// 출력 포맷. 'jpeg' = 갤러리 저장 호환성 (iOS Photos / Android Gallery 모두 지원) +
// PNG 대비 file size ~80~90% 절감 → Supabase Storage 비용 + CDN bandwidth 절감.
// 'webp' 가 jpeg 보다 ~30% 더 작지만 일부 옛 갤러리/공유 시 호환성 이슈 가능 — 안전 우선.
export const PHOTO_CONVERSION_OUTPUT_FORMAT = 'jpeg' as const;

// JPEG 압축 품질. 85 = 시각적 손실 거의 없으면서 file size ~30% 추가 절감.
export const PHOTO_CONVERSION_OUTPUT_COMPRESSION = 85 as const;

// 재시도 정책. failed 사진은 retry sweep job 이 최대 N 회 재시도.
// rejected (모더레이션 거부) 는 재시도 안 함 — 사용자가 다른 사진 업로드 필요.
export const PHOTO_CONVERSION_MAX_RETRIES = 3;

// retry sweep interval — 백필 사진 처리 부담을 분산하기 위해 10 분.
export const PHOTO_CONVERSION_RETRY_INTERVAL_MS = 10 * 60 * 1000;

// retry sweep batch size — 한 번 sweep 에 처리하는 row 수.
// gpt-image-2 호출 ~5~15초 라 batch 50 = 한 사이클 최대 ~12분.
export const PHOTO_CONVERSION_SWEEP_BATCH_SIZE = 50;
