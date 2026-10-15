import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, MAX_FILE_SIZE, UPLOAD_URL, UPLOAD_TIMEOUT, UPLOAD_WAIT_HINT_DELAY } from '../app.js';

for (const extension of ['docx', 'DOCX', 'pdf', 'PDF']) {
    test(`nonempty ${extension} files, including the exact 10 MiB boundary, are accepted`, () => {
        for (const size of [1, MAX_FILE_SIZE]) {
            // Browser MIME values are advisory; the backend verifies the file itself.
            for (const type of ['', 'application/octet-stream', 'text/plain']) {
                assert.equal(validateFile({ name: `yapay-metin.${extension}`, size, type }), null);
            }
        }
        assert.match(validateFile({ name: `bos.${extension}`, size: 0 }), /boş/);
        assert.match(validateFile({ name: `buyuk.${extension}`, size: MAX_FILE_SIZE + 1 }), /10 MiB/);
    });
}

test('other extensions and misleading names are rejected even with a supported MIME type', () => {
    for (const file of [null, { name: 'metin.txt', size: 10, type: 'application/pdf' },
        { name: 'metin.docx.exe', size: 10 }, { name: 'metin.pdf.exe', size: 10 },
        { name: 'metinpdf', size: 10 }, { name: 'metin.doc', size: 10 }]) {
        assert.equal(typeof validateFile(file), 'string');
    }
});

test('the deployed multipart upload endpoint and bounded waiting thresholds remain explicit', () => {
    assert.equal(UPLOAD_URL, 'https://okumadunyasi-api.onrender.com/upload');
    assert.equal(MAX_FILE_SIZE, 10 * 1024 * 1024);
    assert.equal(UPLOAD_TIMEOUT, 90_000);
    assert.equal(UPLOAD_WAIT_HINT_DELAY, 8_000);
});
