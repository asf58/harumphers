import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePhotoPayload } from '../../worker/src/photos.js';

function payload(bytes, contentType, filename = 'fixture-image.bin') {
  return {
    filename,
    contentType,
    base64: Buffer.from(bytes).toString('base64')
  };
}

test('JPEG, PNG, and WebP payloads are accepted from matching magic bytes', () => {
  const cases = [
    [[0xff, 0xd8, 0xff, 0x00], 'image/jpeg'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp']
  ];
  for (const [bytes, contentType] of cases) {
    const result = validatePhotoPayload(payload(bytes, contentType));
    assert.equal(result.contentType, contentType);
    assert.deepEqual([...result.bytes], bytes);
  }
});

test('photo validation rejects unsafe formats, mismatches, invalid base64, and oversized data', () => {
  const invalid = [
    payload([0x3c, 0x73, 0x76, 0x67, 0x3e], 'image/svg+xml', 'fixture.svg'),
    payload([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/jpeg', 'mismatch.jpg'),
    { filename: 'invalid.png', contentType: 'image/png', base64: 'not base64!!!' },
    payload(new Uint8Array(1_048_577).fill(0xff), 'image/jpeg', 'large.jpg')
  ];
  for (const value of invalid) {
    assert.throws(() => validatePhotoPayload(value), error => error.code === 'VALIDATION_FAILED');
  }
});
