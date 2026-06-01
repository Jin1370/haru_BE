import Jimp from 'jimp';

const WATERMARK_TEXT = 'haruvoice.com';
// 워터마크 텍스트 폭을 이미지 폭의 몇 %로 둘지. jimp 비트맵 폰트는 64/128 단위라
// 중간 크기를 못 만들기에, 64px 로 그린 임시 레이어를 이 비율에 맞춰 scale 한다.
// 키우거나 줄이려면 이 값만 조정하면 된다.
const WIDTH_RATIO = 0.22;

// 변환본 이미지 bytes 에 우하단 "haru" 텍스트 워터마크를 합성해 JPEG 로 반환.
// 다운로드 버튼을 누른 시점에만 호출되는 cold path 라 매번 디코드 → 합성 → 인코드
// 해도 부하는 미미하다. 원본/Storage 는 건드리지 않고 응답용 사본만 생성.
//
// 흰 텍스트 + 검정 그림자를 투명 레이어에 그린 뒤 목표 크기로 scale → composite
// 하여, 밝은/어두운 배경 모두에서 가독성을 확보하면서 임의 크기를 지원한다.
export async function addWatermark(imageBytes: Buffer): Promise<Buffer> {
  const image = await Jimp.read(imageBytes);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontShadow = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);

  const baseW = Jimp.measureText(font, WATERMARK_TEXT);
  const baseH = Jimp.measureTextHeight(font, WATERMARK_TEXT, baseW + 10);

  const shadowOffset = Math.max(1, Math.round(baseH * 0.04));
  const layer = new Jimp(baseW + shadowOffset, baseH + shadowOffset, 0x00000000);
  layer.print(fontShadow, shadowOffset, shadowOffset, WATERMARK_TEXT);
  layer.print(font, 0, 0, WATERMARK_TEXT);

  const targetWidth = Math.round(image.bitmap.width * WIDTH_RATIO);
  const scale = targetWidth / layer.bitmap.width;
  if (Math.abs(scale - 1) > 0.01) {
    layer.scale(scale);
  }

  const margin = Math.round(image.bitmap.width * 0.03);
  const x = image.bitmap.width - layer.bitmap.width - margin;
  const y = image.bitmap.height - layer.bitmap.height - margin;
  image.composite(layer, x, y);
  image.quality(90);

  return image.getBufferAsync(Jimp.MIME_JPEG);
}
