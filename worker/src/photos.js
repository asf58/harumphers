import { ApiError } from './errors.js';

const MAX_IMAGE_BYTES = 1024 * 1024;

function invalidPhoto() {
  return new ApiError(400, 'VALIDATION_FAILED', 'Use a JPEG, PNG, or WebP image no larger than 1 MB.');
}

function decodeBase64(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw invalidPhoto();
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw invalidPhoto();
  }
  if (binary.length === 0 || binary.length > MAX_IMAGE_BYTES) throw invalidPhoto();
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function detectedContentType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function validatePhotoPayload(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'base64,contentType,filename'
    || typeof value.filename !== 'string'
    || value.filename.trim() === ''
    || value.filename.length > 160
    || /[\/\\\u0000-\u001f]/.test(value.filename)
    || typeof value.contentType !== 'string'
  ) {
    throw invalidPhoto();
  }
  const bytes = decodeBase64(value.base64);
  const contentType = detectedContentType(bytes);
  if (!contentType || contentType !== value.contentType.toLowerCase()) throw invalidPhoto();
  return { bytes, contentType, filename: value.filename.trim() };
}
