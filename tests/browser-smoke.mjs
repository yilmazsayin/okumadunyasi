import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Synthetic documents and fake speech events only. This never contacts the live API.
let server;
let browser;
let baseURL;

before(async () => {
    const allowedPaths = new Set(['/index.html', '/app.js', '/reading-engine.js']);
    server = createServer(async (request, response) => {
        const path = request.url === '/' ? '/index.html' : request.url;
        if (!allowedPaths.has(path)) { response.writeHead(404).end(); return; }
        try {
            const body = await readFile(new URL(`..${path}`, import.meta.url));
            response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }).end(body);
        } catch { response.writeHead(500).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

async function setup(t, { text = 'Merhaba dünya', supported = true, response, viewport } = {}) {
    const context = await browser.newContext({ viewport: viewport || { width: 1000, height: 900 } });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'no uncaught browser JavaScript errors'));
    await page.route('https://**/*', route => {
        if (route.request().url() === 'https://okumadunyasi-api.onrender.com/upload') {
            return response ? response(route) : route.fulfill({ status: 200, json: { text } });
        }
        return route.abort(); // External fonts are cosmetic; test the fallback too.
    });
    await page.addInitScript(({ supported }) => {
        window.__recognitions = [];
        class FakeRecognition {
            constructor() { this.startCalls = 0; this.stopCalls = 0; this.abortCalls = 0; window.__recognitions.push(this); }
            start() { this.startCalls++; }
            stop() { this.stopCalls++; }
            abort() { this.abortCalls++; }
        }
        Object.defineProperty(window, 'SpeechRecognition', { value: supported ? FakeRecognition : undefined, configurable: true });
        Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
        window.__spokenWords = [];
        Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, speak(utterance) { window.__spokenWords.push(utterance.text); } }, configurable: true });
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    }, { supported });
    await page.goto(baseURL);
    await page.waitForFunction(() => document.getElementById('durum').textContent.length > 0);
    return page;
}

async function upload(page, name = 'yapay-metin.docx') {
    await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('synthetic upload fixture; response is mocked') });
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
}

async function event(page, type, value) {
    await page.evaluate(({ type, value }) => {
        const recognition = window.__recognitions.at(-1);
        if (type === 'result') {
            const result = [{ transcript: value }]; result.isFinal = true;
            recognition.onresult({ resultIndex: 0, results: [result] });
        } else if (type === 'error') recognition.onerror({ error: value });
        else recognition[`on${type}`]();
    }, { type, value });
}

// Model the Web Speech API's cumulative final-results list, including old
// recognizers whose callbacks may already be queued when reading finishes.
async function speechEvent(page, type, value, recognitionIndex = -1) {
    await page.evaluate(({ type, value, recognitionIndex }) => {
        const recognition = window.__recognitions.at(recognitionIndex);
        if (type === 'result') {
            const result = [{ transcript: value }];
            result.isFinal = true;
            recognition.testResults ??= [];
            recognition.testResults.push(result);
            recognition.onresult({ resultIndex: recognition.testResults.length - 1, results: recognition.testResults });
        } else if (type === 'error') recognition.onerror({ error: value });
        else recognition[`on${type}`]();
    }, { type, value, recognitionIndex });
}

async function expectReport(page, expected) {
    assert.equal(await page.locator('#sonucModal').isVisible(), true);
    const stats = await page.evaluate(() => Object.fromEntries(
        ['totalWords', 'correctWords', 'incorrectWords', 'skippedWords', 'unreadWords', 'accuracy']
            .map(id => [id, document.getElementById(id).textContent])
    ));
    assert.deepEqual(stats, {
        totalWords: String(expected.total), correctWords: String(expected.correct),
        incorrectWords: String(expected.incorrect), skippedWords: String(expected.skipped),
        unreadWords: String(expected.unread), accuracy: `%${expected.accuracy}`
    });
}

async function beginReading(page) {
    await page.locator('#baslatBtn').click();
    await speechEvent(page, 'start');
}

test('static ES modules load; DOCX upload text and filename cannot inject HTML', async t => {
    const text = '<img src=x onerror=alert(1)> Merhaba & dünya';
    const page = await setup(t, { text });
    await upload(page, '<svg onload=alert(1)>.docx');
    assert.equal(await page.locator('#okuma-alani img, #okuma-alani svg, #durum svg').count(), 0);
    assert.ok((await page.locator('#okuma-alani').textContent()).includes('<img'));
    assert.ok((await page.locator('#durum').textContent()).includes('<svg onload=alert(1)>.docx'));
    assert.equal(await page.locator('#progressText').isVisible(), true);
    assert.equal(await page.locator('#kelime-0').getAttribute('aria-current'), 'true');
});

test('complete reading waits for microphone end; modal traps focus and can close with Escape', async t => {
    const page = await setup(t);
    await upload(page);
    await page.locator('#baslatBtn').click();
    assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    await event(page, 'start');
    await event(page, 'result', 'MERHABA, DÜNYA!');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 1);
    await event(page, 'end');
    assert.equal(await page.locator('#sonucModal').isVisible(), true);
    assert.equal(await page.locator('#correctWords').textContent(), '2');
    assert.equal(await page.locator('#accuracy').textContent(), '%100');
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '100');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'modalKapatBtn');
    // New report actions may add more buttons; the last one must wrap to close.
    await page.locator('#sonucModal').evaluate(modal => {
        const buttons = [...modal.querySelectorAll('button')].filter(button => !button.disabled && !button.closest('[hidden]'));
        buttons.at(-1).focus();
    });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'modalKapatBtn');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => document.querySelector('.container').inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'baslatBtn');
    await page.locator('#kelime-0').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__spokenWords), ['Merhaba']);
});

test('unexpected end and microphone denial preserve progress and never open a completed report', async t => {
    const page = await setup(t);
    await upload(page);
    await page.locator('#baslatBtn').click(); await event(page, 'start');
    await event(page, 'result', 'merhaba'); await event(page, 'end');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.locator('#baslatBtn').textContent(), 'Devam Et');
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '50');
    await page.locator('#baslatBtn').click();
    await event(page, 'error', 'not-allowed'); await event(page, 'end');
    assert.match(await page.locator('#durum').textContent(), /Mikrofon izni/);
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await page.locator('#baslatBtn').click(); await event(page, 'start');
    await event(page, 'result', 'dünya'); await event(page, 'end');
    assert.equal(await page.locator('#correctWords').textContent(), '2');
});

test('retry during stop queues restart; repeated skipped word positions count separately', async t => {
    const page = await setup(t, { text: 'elma elma' });
    await upload(page);
    await page.locator('#baslatBtn').click(); await event(page, 'start');
    await event(page, 'result', 'armut');
    await page.locator('#retry-word-btn').click();
    assert.equal(await page.evaluate(() => window.__recognitions.length), 1);
    await event(page, 'end');
    assert.equal(await page.evaluate(() => window.__recognitions.length), 2);
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await event(page, 'start'); await event(page, 'result', 'armut');
    await page.locator('#skip-word-btn').click(); await event(page, 'end');
    await event(page, 'start'); await event(page, 'result', 'armut');
    await page.locator('#skip-word-btn').click(); await event(page, 'end');
    assert.equal(await page.locator('#sonucModal').isVisible(), true);
    assert.equal(await page.locator('#skippedWords').textContent(), '2');
    assert.equal(await page.locator('#incorrectWords').textContent(), '2');
    assert.equal(await page.locator('#accuracy').textContent(), '%0');
    assert.equal(await page.locator('#incorrectWordsList').textContent(), 'elma, elma');
    assert.equal(await page.evaluate(() => window.__recognitions.length), 3);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'baslatBtn');
    await page.locator('#baslatBtn').click();
    await event(page, 'start'); await event(page, 'result', 'yanlış'); await event(page, 'end');
    await page.locator('#skip-word-btn').click();
    await event(page, 'start'); await event(page, 'result', 'yanlış'); await event(page, 'end');
    await page.locator('#skip-word-btn').click();
    await page.locator('#retryIncorrectBtn').click();
    assert.equal(await page.locator('.word-button').count(), 2);
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '0');
});

test('microphone error during a correction directs retry to the correction controls and remains recoverable', async t => {
    const page = await setup(t, { text: 'elma' });
    await upload(page);
    await page.locator('#baslatBtn').click(); await event(page, 'start');
    await event(page, 'result', 'armut');
    await event(page, 'error', 'network'); await event(page, 'end');
    assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    assert.match(await page.locator('#durum').textContent(), /Tekrar Oku veya Atla/);
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await page.locator('#retry-word-btn').click(); await event(page, 'start');
    await event(page, 'result', 'elma'); await event(page, 'end');
    assert.equal(await page.locator('#correctWords').textContent(), '1');
    assert.equal(await page.locator('#incorrectWords').textContent(), '0');
});

test('unsupported speech API explains limitation while keeping document display and font controls', async t => {
    const page = await setup(t, { supported: false });
    assert.match(await page.locator('#microphoneHelp').textContent(), /desteklemiyor/);
    await upload(page);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    assert.equal(await page.locator('.word-button').count(), 2);
    await page.locator('#fontIncreaseBtn').click();
    assert.equal(await page.locator('#okuma-alani').evaluate(el => el.style.fontSize), '28px');
});

test('invalid extension, empty file, and oversize file never issue upload requests', async t => {
    let requests = 0;
    const page = await setup(t, { response: route => { requests++; return route.fulfill({ json: { text: 'Merhaba' } }); } });
    for (const [name, buffer, expected] of [
        ['metin.pdf', Buffer.from('test'), /\.docx/],
        ['bos.docx', Buffer.alloc(0), /boş/],
        ['buyuk.docx', Buffer.alloc(10 * 1024 * 1024 + 1), /10 MB/]
    ]) {
        await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
        assert.match(await page.locator('#durum').textContent(), expected);
    }
    assert.equal(requests, 0);
});

test('upload response failures give readable messages and allow another selection', async t => {
    let requests = 0;
    const page = await setup(t, { response: route => {
        requests++;
        if (requests === 1) return route.fulfill({ status: 502, body: '<html>gateway error</html>' });
        if (requests === 2) return route.fulfill({ status: 200, body: 'not JSON' });
        if (requests === 3) return route.fulfill({ status: 200, json: { text: null } });
        if (requests === 4) return route.fulfill({ status: 200, json: { text: ' ... — !!! ' } });
        return route.fulfill({ status: 200, json: { text: 'Merhaba' } });
    } });
    for (const message of [/işlenemedi/, /geçerli bir yanıt/, /okunabilir metin/, /kelime bulunamadı/]) {
        await upload(page);
        assert.match(await page.locator('#durum').textContent(), message);
        assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    }
    await upload(page);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), false);
});

test('real drag and drop handler uploads one synthetic File; keyboard upload control opens chooser', async t => {
    const page = await setup(t);
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#file-upload-area').press('Enter')
    ]);
    assert.equal(chooser.isMultiple(), false);
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['synthetic fixture'], 'ornek.docx'));
        document.getElementById('file-upload-area').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.word-button').length === 2);
    assert.equal(await page.locator('#progressText').isVisible(), true);
});

test('late upload response cannot replace newer document', async t => {
    let releaseFirst;
    let requests = 0;
    const page = await setup(t, { response: async route => {
        requests++;
        if (requests === 1) {
            await new Promise(resolve => { releaseFirst = resolve; });
            try { await route.fulfill({ json: { text: 'Eski metin' } }); } catch { /* request was correctly aborted */ }
        } else await route.fulfill({ json: { text: 'Yeni metin' } });
    } });
    await page.locator('#file-input').setInputFiles({ name: 'bir.docx', buffer: Buffer.from('synthetic one'), mimeType: 'application/octet-stream' });
    while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 10));
    await upload(page, 'iki.docx');
    releaseFirst();
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Yeni metin');
});

test('320px viewport fits document, correction controls and scrollable results without horizontal overflow', async t => {
    const page = await setup(t, { text: 'çokuzunbirörnekkelime'.repeat(6), viewport: { width: 320, height: 568 } });
    await upload(page);
    const hasNoOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(await hasNoOverflow(), true);
    await page.locator('#baslatBtn').click(); await event(page, 'start');
    await event(page, 'result', 'yanlış'); await event(page, 'end');
    assert.equal(await hasNoOverflow(), true);
    assert.equal(await page.locator('#correction-box').isVisible(), true);
    await page.locator('#skip-word-btn').click();
    assert.equal(await page.locator('#sonucModal').isVisible(), true);
    assert.equal(await hasNoOverflow(), true);
    const bounds = await page.locator('.modal-content').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 568);
});

test('finish midway freezes results, waits for microphone end and opens the early report only once', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi kuş');
    await page.evaluate(() => {
        window.__reportFocusCount = 0;
        document.getElementById('modalKapatBtn').addEventListener('focus', () => window.__reportFocusCount++);
    });
    await page.locator('#finishReadingBtn').click();
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 1);
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), true);
    // Simulate rapid repeated clicks and queued speech/error callbacks after finish.
    await page.evaluate(() => {
        const button = document.getElementById('finishReadingBtn');
        button.click(); button.click(); button.click();
    });
    await speechEvent(page, 'result', 'yavaş uçar');
    await speechEvent(page, 'error', 'network');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 2, incorrect: 0, skipped: 0, unread: 2, accuracy: 50 });
    assert.match(await page.locator('#resultSummary').textContent(), /Okuma erken sonlandırıldı/);
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '50');
    assert.equal(await page.locator('#kelime-2').getAttribute('class'), 'word-button');
    assert.equal(await page.locator('#kelime-3').getAttribute('class'), 'word-button');
    await speechEvent(page, 'result', 'yanlış');
    await speechEvent(page, 'error', 'not-allowed');
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 2, incorrect: 0, skipped: 0, unread: 2, accuracy: 50 });
    assert.equal(await page.evaluate(() => window.__reportFocusCount), 1);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 1);
});

test('finish after the first word reports remaining words as unread, not incorrect', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'MAVİ!');
    await page.locator('#finishReadingBtn').click();
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 1, incorrect: 0, skipped: 0, unread: 3, accuracy: 25 });
    assert.equal(await page.locator('#incorrectWordsContainer').isVisible(), false);
});

test('finish with no spoken words works before microphone start and preserves the whole unread document', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), true);
    await upload(page);
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), false);
    await page.locator('#finishReadingBtn').click();
    await expectReport(page, { total: 4, correct: 0, incorrect: 0, skipped: 0, unread: 4, accuracy: 0 });
    assert.match(await page.locator('#resultSummary').textContent(), /Okuma erken sonlandırıldı/);
    assert.equal(await page.evaluate(() => window.__recognitions.length), 0);
});

test('finish while microphone is opening waits for both onstart and onend', async t => {
    const page = await setup(t);
    await upload(page);
    await page.locator('#baslatBtn').click();
    await page.locator('#finishReadingBtn').click();
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 0);
    await speechEvent(page, 'start');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 1);
    await speechEvent(page, 'result', 'merhaba dünya');
    await speechEvent(page, 'end');
    await expectReport(page, { total: 2, correct: 0, incorrect: 0, skipped: 0, unread: 2, accuracy: 0 });
});

test('pause remains resumable and finish from pause opens a report without reopening the microphone', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi');
    assert.equal(await page.locator('#baslatBtn').textContent(), 'Okumayı Durdur');
    await page.locator('#baslatBtn').click();
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await speechEvent(page, 'end');
    assert.equal(await page.locator('#baslatBtn').textContent(), 'Devam Et');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await page.locator('#finishReadingBtn').click();
    await expectReport(page, { total: 4, correct: 1, incorrect: 0, skipped: 0, unread: 3, accuracy: 25 });
    assert.equal(await page.evaluate(() => window.__recognitions.length), 1);
    assert.equal(await page.evaluate(() => window.__recognitions[0].stopCalls), 1);
});

for (const microphoneEnded of [false, true]) {
    test(`finish during ${microphoneEnded ? 'settled' : 'stopping'} word correction preserves its error separately from unread words`, async t => {
        const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
        await upload(page);
        await beginReading(page);
        await speechEvent(page, 'result', 'mavi yanlış');
        if (microphoneEnded) await speechEvent(page, 'end');
        assert.equal(await page.locator('#correction-box').isVisible(), true);
        assert.equal(await page.locator('#finishReadingBtn').isDisabled(), false);
        await page.locator('#finishReadingBtn').click();
        if (!microphoneEnded) {
            assert.equal(await page.locator('#sonucModal').isVisible(), false);
            await speechEvent(page, 'end');
        }
        await expectReport(page, { total: 4, correct: 1, incorrect: 1, skipped: 0, unread: 2, accuracy: 25 });
        assert.equal(await page.locator('#incorrectWordsList').textContent(), 'kuş');
        assert.equal(await page.locator('#correction-box').isVisible(), false);
        assert.equal(await page.locator('#kelime-1').getAttribute('class'), 'word-button incorrect');
        assert.equal(await page.locator('#kelime-2').getAttribute('class'), 'word-button');
        assert.equal(await page.evaluate(() => window.__recognitions.length), 1);
    });
}

test('finish after skipping a failed word keeps the existing skipped and incorrect counts', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi yanlış');
    await speechEvent(page, 'end');
    await page.locator('#skip-word-btn').click();
    await speechEvent(page, 'start');
    await page.locator('#finishReadingBtn').click();
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 1, incorrect: 1, skipped: 1, unread: 2, accuracy: 25 });
    assert.equal(await page.locator('#incorrectWordsList').textContent(), 'kuş');
});

test('finish after a microphone error still waits for onend and protects the early report', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi kuş');
    await speechEvent(page, 'error', 'network');
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), false);
    await page.locator('#finishReadingBtn').click();
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await speechEvent(page, 'error', 'not-allowed');
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 2, incorrect: 0, skipped: 0, unread: 2, accuracy: 50 });
    assert.match(await page.locator('#resultSummary').textContent(), /Okuma erken sonlandırıldı/);
});

test('failed replacement upload restores the early report when microphone end arrived during upload', async t => {
    let requests = 0;
    let releaseUpload;
    let notifyPendingUpload;
    const pendingUpload = new Promise(resolve => { notifyPendingUpload = resolve; });
    const page = await setup(t, { response: async route => {
        if (++requests === 1) return route.fulfill({ json: { text: 'Mavi kuş yavaş uçar' } });
        await new Promise(resolve => { releaseUpload = resolve; notifyPendingUpload(); });
        await route.fulfill({ status: 502, body: 'synthetic upload failure' });
    } });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi');
    await page.evaluate(() => {
        window.__reportFocusCount = 0;
        document.getElementById('modalKapatBtn').addEventListener('focus', () => window.__reportFocusCount++);
    });
    await page.locator('#finishReadingBtn').click();
    await page.locator('#file-input').setInputFiles({ name: 'yeni-yapay-metin.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic replacement fixture') });
    let waitTimer;
    try {
        await Promise.race([
            pendingUpload,
            new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error('replacement upload request did not arrive')), 5000); })
        ]);
    } finally { clearTimeout(waitTimer); }
    assert.equal(await page.locator('#file-upload-area').getAttribute('aria-busy'), 'true');
    await speechEvent(page, 'end');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__reportFocusCount), 0);
    releaseUpload();
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false', null, { timeout: 5000 });
    await expectReport(page, { total: 4, correct: 1, incorrect: 0, skipped: 0, unread: 3, accuracy: 25 });
    assert.match(await page.locator('#resultSummary').textContent(), /Okuma erken sonlandırıldı/);
    assert.match(await page.locator('#durum').textContent(), /işlenemedi/);
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Mavi kuş yavaş uçar');
    await speechEvent(page, 'result', 'kuş yavaş uçar');
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 1, incorrect: 0, skipped: 0, unread: 3, accuracy: 25 });
    assert.equal(await page.evaluate(() => window.__reportFocusCount), 1);
});

test('restart from an early report resets outcomes and old callbacks cannot affect the new reading', async t => {
    const page = await setup(t, { text: 'Mavi kuş yavaş uçar' });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi yanlış');
    await page.locator('#finishReadingBtn').click();
    await speechEvent(page, 'end');
    await page.getByRole('button', { name: 'Yeniden Okumaya Başla', exact: true }).click();
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.locator('.word-button.correct, .word-button.incorrect, .word-button.skipped').count(), 0);
    assert.equal(await page.evaluate(() => window.__recognitions.length), 2);
    await speechEvent(page, 'result', 'kuş yavaş uçar', 0);
    await speechEvent(page, 'error', 'not-allowed', 0);
    await speechEvent(page, 'end', undefined, 0);
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '0');
    await speechEvent(page, 'start');
    await speechEvent(page, 'result', 'mavi kuş yavaş uçar');
    await speechEvent(page, 'end');
    await expectReport(page, { total: 4, correct: 4, incorrect: 0, skipped: 0, unread: 0, accuracy: 100 });
    assert.doesNotMatch(await page.locator('#resultSummary').textContent(), /erken sonlandırıldı/);
});

test('reading the final word remains normal completion and cannot be reclassified as early finish', async t => {
    const page = await setup(t);
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'merhaba');
    await speechEvent(page, 'result', 'dünya');
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), true);
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    await page.evaluate(() => document.getElementById('finishReadingBtn').click());
    await speechEvent(page, 'end');
    await expectReport(page, { total: 2, correct: 2, incorrect: 0, skipped: 0, unread: 0, accuracy: 100 });
    assert.match(await page.locator('#resultSummary').textContent(), /Metnin tamamını bitirdiniz/);
    assert.doesNotMatch(await page.locator('#resultSummary').textContent(), /erken sonlandırıldı/);
});

test('finish is disabled during upload, fits 320px and is usable with keyboard', async t => {
    let releaseUpload;
    const page = await setup(t, {
        viewport: { width: 320, height: 568 },
        response: async route => {
            await new Promise(resolve => { releaseUpload = resolve; });
            await route.fulfill({ json: { text: 'Mavi kuş yavaş uçar' } });
        }
    });
    const finish = page.getByRole('button', { name: 'Bitir ve Sonucu Gör', exact: true });
    assert.equal(await finish.isDisabled(), true);
    await page.locator('#file-input').setInputFiles({ name: 'yapay-metin.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic fixture') });
    while (!releaseUpload) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await finish.isDisabled(), true);
    releaseUpload();
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.equal(await finish.isDisabled(), false);
    const bounds = await finish.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await finish.focus();
    await page.keyboard.press('Space');
    await expectReport(page, { total: 4, correct: 0, incorrect: 0, skipped: 0, unread: 4, accuracy: 0 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'baslatBtn');
    assert.equal(await page.locator('#baslatBtn').textContent(), 'Baştan Oku');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#sonucModal').isVisible(), false);
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.evaluate(() => window.__recognitions.length), 1);
});
