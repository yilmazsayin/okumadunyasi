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
    await page.locator('#file-input').setInputFiles({ name, mimeType: /\.pdf$/i.test(name) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('synthetic upload fixture; response is mocked') });
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

// These fixtures are deliberately longer than both desktop and mobile viewports.
// They contain no documents, names or audio from real children.
const longReadingWords = Array.from({ length: 600 }, (_, index) => ['güneş', 'bulut', 'çiçek', 'ormanda'][index % 4]);

async function viewState(page, ids = []) {
    return page.evaluate(ids => {
        const bounds = element => {
            const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
            return { top, bottom, left, right, width, height };
        };
        return {
            scrollY: window.scrollY,
            width: window.innerWidth,
            height: window.innerHeight,
            active: document.activeElement.id,
            activeDisabled: Boolean(document.activeElement.disabled),
            activeHidden: Boolean(document.activeElement.closest('[hidden], [inert]')),
            activeBounds: bounds(document.activeElement),
            elements: Object.fromEntries(ids.map(id => [id, bounds(document.getElementById(id))]))
        };
    }, ids);
}

function assertInViewport(bounds, state, message) {
    assert.ok(bounds.width > 0 && bounds.height > 0, `${message}: has visible dimensions`);
    assert.ok(bounds.left >= -1 && bounds.right <= state.width + 1, `${message}: fits viewport width`);
    assert.ok(bounds.top >= -1 && bounds.bottom <= state.height + 1, `${message}: fits viewport height`);
}

async function centerWord(page, index) {
    await page.locator(`#kelime-${index}`).evaluate(word => word.scrollIntoView({ block: 'center', behavior: 'instant' }));
}

async function expectVisibleCorrection(page, index, beforeY) {
    const state = await viewState(page, [`kelime-${index}`, 'correction-box', 'retry-word-btn', 'skip-word-btn']);
    assert.ok(Math.abs(state.scrollY - beforeY) <= 32,
        `a word already in view must not jump to the document end (${beforeY} -> ${state.scrollY}; ${JSON.stringify(state.elements)})`);
    assert.equal(state.active, 'retry-word-btn');
    assert.equal(state.activeHidden, false);
    for (const id of [`kelime-${index}`, 'retry-word-btn', 'skip-word-btn']) {
        assertInViewport(state.elements[id], state, id);
    }
    const word = state.elements[`kelime-${index}`];
    const box = state.elements['correction-box'];
    assert.ok(box.bottom <= word.top + 1 || box.top >= word.bottom - 1,
        `correction controls must not cover the failed word (${JSON.stringify({ word, box })})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    return state;
}

async function expectVisibleFocusAndWord(page, index) {
    const state = await viewState(page, [`kelime-${index}`]);
    assert.equal(state.activeHidden, false, 'focus does not remain inside hidden correction controls');
    assert.equal(state.activeDisabled, false, 'the active control is enabled');
    assertInViewport(state.activeBounds, state, 'active reading control');
    assertInViewport(state.elements[`kelime-${index}`], state, 'current reading word');
    return state;
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
        ['metin.txt', Buffer.from('test'), /\.docx|\.pdf/],
        ['bos.docx', Buffer.alloc(0), /boş/],
        ['buyuk.docx', Buffer.alloc(10 * 1024 * 1024 + 1), /10 MiB/]
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

// PDF/DOCX transport and waiting UX use synthetic fixtures and intercepted
// responses. These checks do not claim to validate Render or a real PDF parser.
const scannedPdfMessage = "Bu PDF'de okunabilir metin bulunamadı. Taranmış PDF'ler henüz desteklenmiyor.";

async function installPausedClock(page) {
    const start = new Date('2026-01-01T12:00:00Z');
    await page.clock.install({ time: start });
    // install() initially follows wall time. Pause before selecting the file so
    // network/assertion latency cannot move an 8-second boundary assertion.
    await page.clock.pauseAt(new Date(start.getTime() + 1000));
}

async function traceUploadSignals(page) {
    await page.evaluate(() => {
        const originalFetch = window.fetch.bind(window);
        window.__uploadCalls = [];
        window.fetch = (url, options) => {
            const call = { url, method: options.method, aborted: options.signal.aborted };
            window.__uploadCalls.push(call);
            options.signal.addEventListener('abort', () => { call.aborted = true; });
            return originalFetch(url, options);
        };
    });
}

for (const extension of ['PDF', 'DOCX']) {
    test(`${extension} selection keeps the existing multipart API and reading engine`, async t => {
        const requests = [];
        const page = await setup(t, { response: route => {
            requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
            return route.fulfill({ json: { text: 'Merhaba dünya' } });
        } });
        assert.equal(await page.locator('#uploadFeedback').isVisible(), false);
        assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
        const accept = await page.locator('#file-input').getAttribute('accept');
        assert.match(accept, /\.pdf/);
        assert.match(accept, /\.docx/);
        // Deliberately inaccurate MIME: extension checks must not depend on it.
        await page.locator('#file-input').setInputFiles({ name: `yapay-metin.${extension}`, mimeType: 'text/plain', buffer: Buffer.from('synthetic upload') });
        await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://okumadunyasi-api.onrender.com/upload');
        assert.equal(requests[0].method, 'POST');
        assert.ok(requests[0].body.includes(`name="file"; filename="yapay-metin.${extension}"`));
        assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
        assert.match(await page.locator('#uploadStatus').textContent(), /Metin okumaya hazır/);
        assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
        await beginReading(page);
        await speechEvent(page, 'result', 'MERHABA DÜNYA');
        await speechEvent(page, 'end');
        await expectReport(page, { total: 2, correct: 2, incorrect: 0, skipped: 0, unread: 0, accuracy: 100 });
    });
}

test('PDF text and filename remain literal text; no backend HTML executes', async t => {
    const page = await setup(t, { text: '<img src=x onerror=alert(1)> güneş & bulut' });
    await upload(page, '<svg onload=alert(1)>.pdf');
    assert.equal(await page.locator('#okuma-alani img, #okuma-alani svg, #durum svg, #uploadFeedback svg').count(), 0);
    assert.match(await page.locator('#okuma-alani').textContent(), /<img/);
    assert.match(await page.locator('#durum').textContent(), /<svg onload=alert\(1\)>.pdf/);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), false);
});

test('PDF drag and drop uses the existing upload flow and keyboard chooser accepts both formats', async t => {
    let requests = 0;
    const page = await setup(t, { response: route => { requests++; return route.fulfill({ json: { text: 'Mavi kuş' } }); } });
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#file-upload-area').press('Space')
    ]);
    assert.equal(chooser.isMultiple(), false);
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['synthetic PDF fixture'], 'yapay.PDF', { type: 'application/pdf' }));
        document.getElementById('file-upload-area').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.getElementById('uploadFeedback').dataset.state === 'ready');
    assert.equal(requests, 1);
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Mavi kuş');
});

for (const [status, error, expected = error] of [
    [400, 'Bu PDF parola ile korunuyor. Parolasız bir PDF seçin.'],
    [413, 'Dosya çok büyük. En fazla 10 MB boyutunda bir dosya seçin.'],
    [422, 'PDF dosyasında seçilebilir metin bulunamadı. Taranmış belgeler için OCR desteği henüz yok.', scannedPdfMessage],
    [500, 'Dosya şu anda işlenemedi. Lütfen yeniden deneyin.'],
    [400, 'PDF dosyası bozuk veya geçersiz. Başka bir dosya seçin.']
]) {
    test(`PDF HTTP ${status} JSON error is readable, safely rendered and recoverable: ${error}`, async t => {
        let requests = 0;
        const page = await setup(t, { response: route => ++requests === 1
            ? route.fulfill({ status, json: { error } })
            : route.fulfill({ json: { text: 'Yeniden deneyelim' } }) });
        await upload(page, 'yapay.pdf');
        assert.ok((await page.locator('#durum').textContent()).includes(expected));
        assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'error');
        assert.equal(await page.locator('#file-upload-area').getAttribute('aria-busy'), 'false');
        assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
        assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
        await upload(page, 'ikinci-yapay.pdf');
        assert.equal(await page.locator('#baslatBtn').isDisabled(), false);
        assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    });
}

test('backend JSON error HTML is shown literally while non-JSON error bodies use a safe fallback', async t => {
    let requests = 0;
    const literalError = '<img src=x onerror=alert(1)> Yapay hata';
    const page = await setup(t, { response: route => ++requests === 1
        ? route.fulfill({ status: 422, json: { error: literalError } })
        : route.fulfill({ status: 500, contentType: 'text/html', body: '<html><h1>private synthetic gateway detail</h1></html>' }) });
    await upload(page, 'bir.pdf');
    assert.ok((await page.locator('#durum').textContent()).includes(literalError));
    assert.equal(await page.locator('#durum img, #uploadFeedback img').count(), 0);
    await upload(page, 'iki.pdf');
    assert.match(await page.locator('#durum').textContent(), /işlenemedi|sunucu|Sunucu/);
    assert.doesNotMatch(await page.locator('#durum').textContent(), /private synthetic|<html>/);
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'error');
});

test('empty PDF text gets the scanned PDF explanation; malformed successful payloads never start reading', async t => {
    let requests = 0;
    const payloads = [
        { json: { text: '' } }, { json: { text: ' \n\t ' } },
        { json: { text: null } }, { json: {} }, { body: 'not JSON' },
        { json: { text: '... — !!!' } }
    ];
    const page = await setup(t, { response: route => route.fulfill({ status: 200, ...payloads[requests++] }) });
    for (let index = 0; index < payloads.length; index++) {
        await upload(page, `gecersiz-${index}.pdf`);
        const message = await page.locator('#durum').textContent();
        if (index < 2) assert.ok(message.includes(scannedPdfMessage));
        else assert.match(message, /metin|yanıt|kelime/);
        assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
        assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'error');
        assert.equal(await page.locator('.word-button').count(), 0);
    }
});

test('pending upload shows real elapsed time and delayed Render help without inventing a percentage', async t => {
    let release;
    let received;
    const pending = new Promise(resolve => { received = resolve; });
    const page = await setup(t, { response: async route => {
        await new Promise(resolve => { release = resolve; received(); });
        await route.fulfill({ json: { text: 'Hazır metin' } });
    } });
    await installPausedClock(page);
    await traceUploadSignals(page);
    await page.locator('#file-input').setInputFiles({ name: 'bekleyen.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic pending upload') });
    await pending;
    assert.equal(await page.locator('#file-upload-area').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'busy');
    assert.equal(await page.locator('#uploadStatus').getAttribute('role'), 'status');
    assert.match(await page.locator('#uploadStatus').textContent(), /^Dosya gönderiliyor\. Sunucudan yanıt bekleniyor/);
    const progress = page.locator('#uploadProgress');
    assert.equal(await progress.isVisible(), true);
    assert.equal(await progress.getAttribute('role'), 'progressbar');
    assert.equal(await progress.getAttribute('aria-valuenow'), null);
    assert.doesNotMatch(await page.locator('#uploadFeedback').textContent(), /%\s*\d|\d\s*%/);
    const initiallyElapsed = await page.locator('#uploadElapsed').textContent();
    await page.clock.runFor(7_999);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
    await page.clock.runFor(1);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), true);
    assert.match(await page.locator('#uploadWaitHint').textContent(), /Render|sunucu/i);
    assert.notEqual(await page.locator('#uploadElapsed').textContent(), initiallyElapsed);
    assert.match(await page.locator('#uploadElapsed').textContent(), /8/);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    assert.equal(await page.locator('#finishReadingBtn').isDisabled(), true);
    release();
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
    assert.equal(await progress.isVisible(), false);
    const stoppedElapsed = await page.locator('#uploadElapsed').textContent();
    await page.clock.runFor(12_000);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false, 'a completed upload cannot show a late waiting hint');
    assert.equal(await page.locator('#uploadElapsed').textContent(), stoppedElapsed, 'elapsed timer stops on completion');
    assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.aborted)), [false]);
});

test('response parsing has a truthful processing state before the extracted text becomes ready', async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.__uploadPhases = [];
        const feedback = document.getElementById('uploadFeedback');
        new MutationObserver(records => {
            for (const record of records) if (record.oldValue) window.__uploadPhases.push(record.oldValue);
        }).observe(feedback, { attributes: true, attributeFilter: ['data-phase'], attributeOldValue: true });
        window.fetch = async () => ({
            ok: true,
            status: 200,
            json: () => new Promise(resolve => { window.__releaseParsedText = () => resolve({ text: 'Hazırlanan metin' }); })
        });
    });
    await page.locator('#file-input').setInputFiles({ name: 'islenen.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic processing fixture') });
    await page.waitForFunction(() => document.getElementById('uploadFeedback').dataset.phase === 'processing');
    assert.equal(await page.locator('#file-upload-area').getAttribute('aria-busy'), 'true');
    assert.match(await page.locator('#uploadStatus').textContent(), /^Metin hazırlanıyor/);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), true);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.__uploadPhases), ['preparing', 'sending']);
    await page.evaluate(() => window.__releaseParsedText());
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Hazırlanan metin');
});

test('an already queued old fetch completion is ignored even when its source fails to honor abort', async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.__queuedUploads = [];
        window.fetch = (url, options) => new Promise(resolve => {
            const queued = {
                aborted: options.signal.aborted,
                resolve: text => resolve({ ok: true, status: 200, json: async () => ({ text }) })
            };
            options.signal.addEventListener('abort', () => { queued.aborted = true; });
            // Deliberately keep this promise alive after abort, to model an
            // already queued callback and verify the request-number guard.
            window.__queuedUploads.push(queued);
        });
    });
    for (const name of ['eski.pdf', 'yeni.pdf']) {
        await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(name) });
    }
    assert.deepEqual(await page.evaluate(() => window.__queuedUploads.map(call => call.aborted)), [true, false]);
    await page.evaluate(() => window.__queuedUploads[1].resolve('Yeni kuş'));
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => {
        window.__queuedUploads[0].resolve('Eski bulut');
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Yeni kuş');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    assert.match(await page.locator('#uploadStatus').textContent(), /yeni\.pdf/);
});

test('an old JSON body that completes after the new upload cannot change its document or status', async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.__pendingUploadBodies = [];
        window.fetch = async (url, options) => ({
            ok: true, status: 200,
            json: () => new Promise(resolve => {
                // Model a response body callback already queued before abort.
                window.__pendingUploadBodies.push({ signal: options.signal, resolve });
            })
        });
    });
    for (const [index, name] of ['eski.pdf', 'yeni.pdf'].entries()) {
        await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(name) });
        await page.waitForFunction(length => window.__pendingUploadBodies.length === length, index + 1);
    }
    assert.deepEqual(await page.evaluate(() => window.__pendingUploadBodies.map(call => call.signal.aborted)), [true, false]);
    await page.evaluate(() => window.__pendingUploadBodies[1].resolve({ text: 'Yeni metin hazır' }));
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => {
        window.__pendingUploadBodies[0].resolve({ text: 'Eski metin geç geldi' });
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Yeni metin hazır');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    assert.match(await page.locator('#uploadStatus').textContent(), /yeni\.pdf/);
});

test('90-second timeout aborts the real fetch signal and preserves the prior document and reading statistics', async t => {
    let requests = 0;
    let release;
    let received;
    const pending = new Promise(resolve => { received = resolve; });
    const page = await setup(t, { response: async route => {
        if (++requests === 1) return route.fulfill({ json: { text: 'Mavi kuş yavaş uçar' } });
        await new Promise(resolve => { release = resolve; received(); });
        try { await route.fulfill({ json: { text: 'Geç gelen metin' } }); } catch { /* native fetch was aborted */ }
    } });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', 'mavi');
    await page.locator('#baslatBtn').click();
    await speechEvent(page, 'end');
    await installPausedClock(page);
    await traceUploadSignals(page);
    await page.locator('#file-input').setInputFiles({ name: 'yavas.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic timeout fixture') });
    await pending;
    await page.clock.runFor(89_999);
    assert.equal(await page.locator('#file-upload-area').getAttribute('aria-busy'), 'true');
    await page.clock.runFor(1);
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.aborted)), [true]);
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'error');
    assert.match(await page.locator('#durum').textContent(), /zaman|sür|yanıt/i);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Mavi kuş yavaş uçar');
    assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '25');
    assert.equal(await page.locator('#kelime-0').getAttribute('class'), 'word-button correct');
    release();
    await page.locator('#finishReadingBtn').click();
    await expectReport(page, { total: 4, correct: 1, incorrect: 0, skipped: 0, unread: 3, accuracy: 25 });
});

test('a new PDF aborts the prior upload and late results cannot replace it or its ready status', async t => {
    let release;
    let received;
    let requests = 0;
    const pending = new Promise(resolve => { received = resolve; });
    const page = await setup(t, { response: async route => {
        if (++requests === 1) {
            await new Promise(resolve => { release = resolve; received(); });
            try { await route.fulfill({ json: { text: 'Eski PDF metni' } }); } catch { /* native fetch was aborted */ }
        } else await route.fulfill({ json: { text: 'Yeni PDF metni' } });
    } });
    await installPausedClock(page);
    await traceUploadSignals(page);
    await page.locator('#file-input').setInputFiles({ name: 'eski.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic old PDF') });
    await pending;
    await upload(page, 'yeni.pdf');
    assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.aborted)), [true, false]);
    release();
    await page.clock.runFor(10_000);
    assert.equal((await page.locator('#okuma-alani').textContent()).trim(), 'Yeni PDF metni');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
    assert.match(await page.locator('#uploadStatus').textContent(), /Metin okumaya hazır/);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), false);
});

test('repeated in-flight PDF selection with matching metadata issues one request and does not restart its timer', async t => {
    let release;
    let received;
    let requests = 0;
    const pending = new Promise(resolve => { received = resolve; });
    const page = await setup(t, { response: async route => {
        requests++;
        await new Promise(resolve => { release = resolve; received(); });
        await route.fulfill({ json: { text: 'Tek bir metin' } });
    } });
    await installPausedClock(page);
    await traceUploadSignals(page);
    const dispatchSameFile = () => page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['synthetic duplicate fixture'], 'ayni.pdf', { type: 'application/pdf', lastModified: 1234 }));
        document.getElementById('file-upload-area').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await dispatchSameFile();
    await pending;
    await page.clock.runFor(4_000);
    await dispatchSameFile();
    await dispatchSameFile();
    assert.equal(await page.evaluate(() => window.__uploadCalls.length), 1);
    assert.equal(requests, 1);
    assert.deepEqual(await page.evaluate(() => window.__uploadCalls.map(call => call.aborted)), [false]);
    await page.clock.runFor(4_000);
    assert.equal(await page.locator('#uploadWaitHint').isVisible(), true, 'duplicate events do not postpone the slow-server explanation');
    release();
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#uploadFeedback').getAttribute('data-state'), 'ready');
});

test('320px upload layout keeps the busy status, timer and server explanation inside the viewport width', async t => {
    let release;
    let received;
    const pending = new Promise(resolve => { received = resolve; });
    const page = await setup(t, { viewport: { width: 320, height: 360 }, response: async route => {
        await new Promise(resolve => { release = resolve; received(); });
        await route.fulfill({ json: { text: 'Mobil metin' } });
    } });
    await installPausedClock(page);
    const originalScrollY = await page.evaluate(() => window.scrollY);
    await page.locator('#file-input').setInputFiles({ name: 'cokuzun-yapay-dosya-adi'.repeat(5) + '.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic mobile fixture') });
    await pending;
    let promptState = await viewState(page, ['uploadPrompt']);
    assertInViewport(promptState.elements.uploadPrompt, promptState, 'mobile upload status in the file picker');
    assert.match(await page.locator('#uploadPrompt').textContent(), /Dosya gönderiliyor.*Sunucudan yanıt bekleniyor/);
    await page.clock.runFor(8_000);
    promptState = await viewState(page, ['uploadPrompt']);
    assertInViewport(promptState.elements.uploadPrompt, promptState, 'mobile delayed-server explanation in the file picker');
    assert.match(await page.locator('#uploadPrompt').textContent(), /Sunucudan yanıt bekleniyor.*İlk açılış.*yeniden dosya seçmeniz gerekmez/);
    assert.equal(promptState.scrollY, originalScrollY, 'upload feedback never forces mobile page scrolling');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const id of ['uploadFeedback', 'uploadStatus', 'uploadElapsed', 'uploadWaitHint']) {
        const bounds = await page.locator(`#${id}`).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321, `${id} fits 320px`);
    }
    release();
    await page.waitForFunction(() => document.getElementById('file-upload-area').getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#baslatBtn').isDisabled(), false);
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

for (const viewport of [{ width: 1000, height: 900 }, { width: 320, height: 480 }, { width: 320, height: 360 }]) {
    for (const index of [300, 558]) {
        test(`long document correction at word ${index} keeps word, keyboard controls and focus visible at ${viewport.width}x${viewport.height}`, async t => {
            const page = await setup(t, { text: longReadingWords.join(' '), viewport });
            await upload(page);
            await beginReading(page);
            await speechEvent(page, 'result', longReadingWords.slice(0, index).join(' '));
            await centerWord(page, index);
            const before = await viewState(page, [`kelime-${index}`]);
            assertInViewport(before.elements[`kelime-${index}`], before, 'word before failure');
            assert.ok(before.scrollY > viewport.height, 'fixture reaches the middle or end of a long page');

            await speechEvent(page, 'result', 'yanlış');
            await expectVisibleCorrection(page, index, before.scrollY);
            await speechEvent(page, 'end');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'retry-word-btn');
            const beforeManualScroll = await page.evaluate(() => window.scrollY);
            await page.mouse.move(2, viewport.height / 2);
            await page.mouse.wheel(0, -250);
            await page.waitForFunction(beforeY => window.scrollY < beforeY, beforeManualScroll);
            assert.equal(await page.locator('#correction-box').isVisible(), true,
                'manual scrolling remains available while correction controls stay accessible');
            await centerWord(page, index);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'retry-word-btn');
            // The focused correction control is already in view. Keyboard
            // activation cannot hide a scroll bug through Playwright auto-scroll.
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#correction-box').isVisible(), false);
            await speechEvent(page, 'start');
            const beforeNextCorrection = await expectVisibleFocusAndWord(page, index);
            assert.equal(await page.locator(`#kelime-${index}`).getAttribute('class'), 'word-button');

            await speechEvent(page, 'result', `${longReadingWords[index]} yanlış`);
            await expectVisibleCorrection(page, index + 1, beforeNextCorrection.scrollY);
            await speechEvent(page, 'end');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'skip-word-btn');
            const beforeSkip = await viewState(page);
            assertInViewport(beforeSkip.activeBounds, beforeSkip, 'skip before keyboard activation');
            await page.keyboard.press('Enter');
            await speechEvent(page, 'start');
            const afterSkip = await expectVisibleFocusAndWord(page, index + 2);
            assert.ok(Math.abs(afterSkip.scrollY - beforeSkip.scrollY) < viewport.height,
                'retry and skip stay near the current reading position');
            assert.equal(await page.locator(`#kelime-${index + 1}`).getAttribute('class'), 'word-button skipped');
            assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuetext'), `${index + 2} / 600 kelime`);
            assert.equal(await page.locator('#sonucModal').isVisible(), false);
        });
    }
}

for (const viewport of [{ width: 1000, height: 600 }, { width: 320, height: 480 }, { width: 320, height: 360 }]) {
    test(`long early report isolates scrolling, restores position and restarts visibly at ${viewport.width}x${viewport.height}`, async t => {
        // Failed synthetic words make the actual practice list long; the test
        // does not enlarge the dialog or inject extra report nodes artificially.
        const words = Array.from({ length: 600 }, (_, index) => `masaldakiküçükkaplumbağa${index}`);
        const page = await setup(t, { text: words.join(' '), viewport });
        await upload(page);
        await beginReading(page);
        await page.evaluate(() => {
            for (let index = 0; index < 80; index++) {
                const recognition = window.__recognitions.at(-1);
                const result = [{ transcript: 'yanlış' }]; result.isFinal = true;
                recognition.onresult({ resultIndex: 0, results: [result] });
                recognition.onend();
                document.getElementById('skip-word-btn').click();
                window.__recognitions.at(-1).onstart();
            }
        });
        await speechEvent(page, 'result', words.slice(80, 300).join(' '));
        await centerWord(page, 300);
        const beforeFailure = await viewState(page);
        await speechEvent(page, 'result', 'yanlış');
        await expectVisibleCorrection(page, 300, beforeFailure.scrollY);
        await speechEvent(page, 'end');
        const beforeReport = await viewState(page, ['kelime-300']);
        // Dispatch from the existing reading position so the automation itself
        // cannot scroll the offscreen finish button before the report opens.
        await page.evaluate(() => document.getElementById('finishReadingBtn').click());
        await expectReport(page, { total: 600, correct: 220, incorrect: 81, skipped: 80, unread: 299, accuracy: 37 });
        await page.locator('.modal-content').evaluate(async content => {
            await Promise.all(content.getAnimations().map(animation => animation.finished));
        });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'modalKapatBtn');
        assert.equal(await page.locator('.modal-content').evaluate(content => content.scrollTop), 0);
        const report = await viewState(page);
        const bounds = await page.locator('.modal-content').boundingBox();
        assertInViewport({ ...bounds, left: bounds.x, right: bounds.x + bounds.width, top: bounds.y, bottom: bounds.y + bounds.height }, report, 'centered report');
        assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 2, 'report is horizontally centered');
        assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) <= 2, 'report is vertically centered');
        const maxScroll = await page.locator('.modal-content').evaluate(content => content.scrollHeight - content.clientHeight);
        assert.ok(maxScroll > 100, `actual long report scrolls inside the dialog (${maxScroll}px available)`);
        await page.keyboard.press('Shift+Tab');
        const wrappedLast = await viewState(page);
        assert.equal(wrappedLast.active, 'restartReadingBtn');
        assertInViewport(wrappedLast.activeBounds, wrappedLast, 'last report action after reverse Tab wrap');
        assert.equal(wrappedLast.scrollY, report.scrollY, 'keyboard focus scrolls only inside the report');
        await page.keyboard.press('Tab');
        const wrappedFirst = await viewState(page);
        assert.equal(wrappedFirst.active, 'modalKapatBtn');
        assertInViewport(wrappedFirst.activeBounds, wrappedFirst, 'report close after forward Tab wrap');
        assert.equal(wrappedFirst.scrollY, report.scrollY);
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, 250);
        await page.waitForFunction(() => document.querySelector('.modal-content').scrollTop > 0);
        assert.equal(await page.evaluate(() => window.scrollY), report.scrollY, 'scrolling the report does not scroll the page');

        await page.locator('.modal-content').evaluate(content => { content.scrollTop = content.scrollHeight; });
        await page.mouse.wheel(0, 350);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.scrollY), report.scrollY, 'scrolling past the dialog bottom does not chain to the page');
        await page.mouse.move(2, viewport.height / 2);
        await page.mouse.wheel(0, 350);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.scrollY), report.scrollY, 'wheel input outside the report keeps the page locked');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#sonucModal').isVisible(), false);
        const afterClose = await viewState(page, ['kelime-300']);
        assert.ok(Math.abs(afterClose.scrollY - beforeReport.scrollY) <= 2, 'closing restores the previous document scroll position');
        assert.equal(afterClose.activeHidden, false);
        assert.equal(afterClose.activeDisabled, false);
        assert.notEqual(afterClose.active, 'modalKapatBtn');
        assertInViewport(afterClose.elements['kelime-300'], afterClose, 'failed word after closing report');
        assert.equal(await page.evaluate(() => document.querySelector('.container').inert), false);

        // A new reading can reopen the same dialog after it was scrolled. The
        // report must always start at its heading, rather than its prior offset.
        await page.evaluate(() => document.getElementById('baslatBtn').click());
        await speechEvent(page, 'start');
        await speechEvent(page, 'result', words.slice(0, 300).join(' '));
        await centerWord(page, 300);
        const secondBeforeReport = await page.evaluate(() => window.scrollY);
        await page.evaluate(() => document.getElementById('finishReadingBtn').click());
        await speechEvent(page, 'end');
        await expectReport(page, { total: 600, correct: 300, incorrect: 0, skipped: 0, unread: 300, accuracy: 50 });
        assert.equal(await page.locator('.modal-content').evaluate(content => content.scrollTop), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'modalKapatBtn');
        await page.keyboard.press('Escape');
        assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - secondBeforeReport) <= 2);

        // Reopen once more and use the actual report restart action.
        await page.evaluate(() => document.getElementById('baslatBtn').click());
        await speechEvent(page, 'start');
        await speechEvent(page, 'result', words.slice(0, 300).join(' '));
        await centerWord(page, 300);
        await page.evaluate(() => document.getElementById('finishReadingBtn').click());
        await speechEvent(page, 'end');
        await page.locator('#restartReadingBtn').click();
        assert.equal(await page.locator('#sonucModal').isVisible(), false);
        assert.equal(await page.locator('#progressContainer').getAttribute('aria-valuenow'), '0');
        const restarted = await expectVisibleFocusAndWord(page, 0);
        assert.equal(await page.locator('#kelime-0').getAttribute('aria-current'), 'true');
        assert.ok(restarted.scrollY < beforeReport.scrollY, 'restart returns to the beginning of the document');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        // Background scrolling becomes available again after either close or restart.
        const beforeWheel = await page.evaluate(() => window.scrollY);
        await page.mouse.move(viewport.width / 2, viewport.height - 5);
        await page.mouse.wheel(0, 250);
        await page.waitForFunction(before => window.scrollY > before, beforeWheel);
    });
}

test('report scroll lock restores existing inline overflow values and priorities after closing', async t => {
    const page = await setup(t, { text: longReadingWords.join(' '), viewport: { width: 1000, height: 900 } });
    await upload(page);
    await beginReading(page);
    await speechEvent(page, 'result', longReadingWords.slice(0, 300).join(' '));
    await centerWord(page, 300);
    const readStyles = () => page.evaluate(() => ['body', 'html'].map(selector => {
        const { style } = document.querySelector(selector);
        return Object.fromEntries(['overflow-x', 'overflow-y', 'position', 'top', 'left', 'width', 'padding-right']
            .map(property => [property, [style.getPropertyValue(property), style.getPropertyPriority(property)]]));
    }));
    await page.evaluate(() => {
        document.body.style.setProperty('overflow-x', 'hidden', 'important');
        document.body.style.setProperty('overflow-y', 'visible');
        document.documentElement.style.setProperty('overflow-x', 'clip');
        document.documentElement.style.setProperty('overflow-y', 'scroll', 'important');
    });
    const previousStyles = await readStyles();
    const previousY = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.getElementById('finishReadingBtn').click());
    await speechEvent(page, 'end');
    assert.equal(await page.locator('#sonucModal').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(await readStyles(), previousStyles, 'scroll locking preserves individual overflow priorities and pre-existing styles');
    assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - previousY) <= 2);
});
