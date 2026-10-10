import fs from 'node:fs';
import type { KK9ImageInfo } from '../types/index.js';

/**
 * 将图片读取为 Data URL Base64 格式（便于直接喂给视觉/多模态 LLM）
 */
export function readImageAsBase64(imageInfo: KK9ImageInfo): string | null {
  if (!imageInfo.filePath || !fs.existsSync(imageInfo.filePath)) {
    return null;
  }
  const mimeType = imageInfo.mimeType || 'image/png';
  const buf = fs.readFileSync(imageInfo.filePath);
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

/**
 * 将缓存的图片文件另存为指定的目标文件路径（如自动补全 .png 扩展名）
 */
export function saveImageToFile(imageInfo: KK9ImageInfo, destPath: string): boolean {
  if (!imageInfo.filePath || !fs.existsSync(imageInfo.filePath)) {
    return false;
  }
  fs.copyFileSync(imageInfo.filePath, destPath);
  return true;
}

