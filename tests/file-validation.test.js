import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, MAX_FILE_SIZE, UPLOAD_URL } from '../app.js';

test('only nonempty DOCX files up to 10 MB are accepted, including uppercase extension', () => {
    assert.equal(validateFile({ name: 'yapay-metin.DOCX', size: MAX_FILE_SIZE }), null);
    for (const file of [null, { name: 'metin.pdf', size: 10 }, { name: 'metin.docx.exe', size: 10 },
        { name: 'metin.docx', size: 0 }, { name: 'metin.docx', size: MAX_FILE_SIZE + 1 }]) {
        assert.equal(typeof validateFile(file), 'string');
    }
});

test('the deployed DOCX upload endpoint remains unchanged', () => {
    assert.equal(UPLOAD_URL, 'https://okumadunyasi-api.onrender.com/upload');
});
