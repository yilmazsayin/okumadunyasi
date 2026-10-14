import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingEngine, normalizeWord, tokenizeText } from '../reading-engine.js';

class FakeRecognition {
    constructor() {
        this.startCalls = 0;
        this.stopCalls = 0;
        this.abortCalls = 0;
    }

    start() { this.startCalls++; }
    stop() { this.stopCalls++; }
    abort() { this.abortCalls++; }
    started() { this.onstart?.(); }
    ended() { this.onend?.(); }
    error(error) { this.onerror?.({ error }); }
    result(transcripts, resultIndex = 0) {
        this.onresult?.({
            resultIndex,
            results: transcripts.map(value => {
                const result = [{ transcript: typeof value === 'string' ? value : value.text }];
                result.isFinal = typeof value === 'string' || value.final;
                return result;
            }),
        });
    }
}

function setup(words = ['Ali', 'okula', 'gitti.']) {
    const recognizers = [];
    const changes = [];
    const engine = new ReadingEngine({
        createRecognition: () => {
            const recognition = new FakeRecognition();
            recognizers.push(recognition);
            return recognition;
        },
        onChange: state => changes.push(state),
    });
    engine.load(words);
    return { engine, recognizers, changes };
}

function listen(engine, recognizers) {
    engine.start();
    const recognition = recognizers.at(-1);
    recognition.started();
    return recognition;
}

test('a shutdown error after the last accepted word cannot reopen an already finished reading', () => {
    const { engine, recognizers } = setup(['elma']);
    const recognition = listen(engine, recognizers);
    recognition.result(['elma']);
    recognition.error('network');
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'completed');
    assert.equal(engine.snapshot().stats.correct, 1);
    engine.start();
    recognizers.at(-1).started();
    assert.equal(engine.snapshot().index, 0);
    assert.equal(engine.snapshot().phase, 'listening');
});

test('Turkish case, NFC, apostrophes and punctuation normalize on both sides', () => {
    assert.equal(normalizeWord('IŞIK'), 'ışık');
    assert.equal(normalizeWord('I\u0307STANBUL'), 'istanbul');
    assert.equal(normalizeWord('“Ali’nin,”'), normalizeWord("ALİ'NİN!"));
    assert.equal(normalizeWord('(ÖĞRENCİ)…'), 'öğrenci');
    assert.deepEqual(tokenizeText('  Ali,\n—\tışık! ... 🌟  '), ['Ali,', 'ışık!']);
    const { engine, recognizers } = setup(['“İSTANBUL,”', 'IŞIK!', "Ali'nin."]);
    const recognition = listen(engine, recognizers);
    recognition.result(['istanbul ışık ali’nin']);
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'completed');
    assert.equal(engine.snapshot().stats.accuracy, 100);
});

test('start is idempotent while starting and listening', () => {
    const { engine, recognizers } = setup();
    engine.start();
    engine.start();
    assert.equal(recognizers.length, 1);
    assert.equal(recognizers[0].startCalls, 1);
    assert.equal(engine.snapshot().phase, 'starting');
    recognizers[0].started();
    engine.start();
    assert.equal(recognizers.length, 1);
    assert.equal(engine.snapshot().phase, 'listening');
    assert.equal(recognizers[0].lang, 'tr-TR');
    assert.equal(recognizers[0].continuous, true);
    assert.equal(recognizers[0].interimResults, false);
});

test('pause before onstart waits for start, then stops before a queued resume', () => {
    const { engine, recognizers } = setup();
    engine.start();
    const first = recognizers[0];
    engine.pause();
    engine.start();
    engine.start();
    assert.equal(first.stopCalls, 0);
    assert.equal(recognizers.length, 1);
    first.started();
    assert.equal(first.stopCalls, 1);
    assert.equal(engine.snapshot().phase, 'stopping');
    first.result(['Ali']);
    assert.equal(engine.snapshot().index, 0);
    first.ended();
    assert.equal(recognizers.length, 2);
    assert.equal(recognizers[1].startCalls, 1);
});

test('pause and unexpected onend preserve partial progress without completion', () => {
    const { engine, recognizers, changes } = setup();
    let recognition = listen(engine, recognizers);
    recognition.result(['Ali']);
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'paused');
    assert.deepEqual(engine.snapshot().stats, {
        total: 3, correct: 1, incorrect: 0, skipped: 0, unread: 2,
        processed: 1, accuracy: 33, completed: false,
    });
    assert.equal(changes.some(state => state.phase === 'completed'), false);
    recognition = listen(engine, recognizers);
    recognition.result(['okula']);
    engine.pause();
    recognition.result(['okula gitti']);
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'paused');
    assert.equal(engine.snapshot().index, 2);
    assert.equal(engine.snapshot().stats.completed, false);
});

test('all new final results from resultIndex are processed once; interim results are ignored', () => {
    const { engine, recognizers } = setup(['bir', 'iki', 'üç', 'dört']);
    const recognition = listen(engine, recognizers);
    recognition.result([{ text: 'bir', final: false }]);
    assert.equal(engine.snapshot().index, 0);
    recognition.result(['bir', 'iki']);
    assert.equal(engine.snapshot().index, 2);
    recognition.result(['bir', 'iki']);
    assert.equal(engine.snapshot().index, 2);
    recognition.result(['bir', 'iki', { text: 'üç', final: false }], 2);
    assert.equal(engine.snapshot().index, 2);
    recognition.result(['bir', 'iki', 'üç', 'dört'], 2);
    assert.equal(engine.snapshot().stats.correct, 4);
    assert.equal(recognition.stopCalls, 1);
    assert.equal(engine.snapshot().phase, 'stopping');
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'completed');
});

test('first wrong word stops a result chunk and correction cannot double-count', () => {
    const { engine, recognizers } = setup(['Ali', 'okula', 'gitti']);
    const recognition = listen(engine, recognizers);
    recognition.result(['Ali yanlış gitti', 'gitti']);
    assert.deepEqual(engine.snapshot().outcomes, ['correct', 'incorrect', 'pending']);
    assert.equal(engine.snapshot().index, 1);
    assert.equal(engine.snapshot().correctionPending, true);
    assert.equal(recognition.stopCalls, 1);
    recognition.result(['Ali yanlış gitti', 'gitti']);
    assert.equal(engine.snapshot().stats.incorrect, 1);
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'correction');
});

test('retry clicked before onend queues exactly one restart and replaces the outcome', () => {
    const { engine, recognizers } = setup(['Ali', 'gitti']);
    const first = listen(engine, recognizers);
    first.result(['başka']);
    engine.retryWord();
    engine.retryWord();
    engine.skipWord();
    assert.equal(engine.snapshot().stats.incorrect, 0);
    assert.equal(engine.snapshot().stats.unread, 2);
    assert.equal(engine.snapshot().index, 0);
    assert.equal(recognizers.length, 1);
    first.ended();
    assert.equal(recognizers.length, 2);
    assert.equal(engine.snapshot().phase, 'starting');
    const second = recognizers[1];
    second.started();
    second.result(['Ali']);
    assert.deepEqual(engine.snapshot().outcomes, ['correct', 'pending']);
    assert.equal(engine.snapshot().stats.correct, 1);
    assert.equal(engine.snapshot().stats.incorrect, 0);
});

test('repeated failed attempts at one position never accumulate incorrect counts', () => {
    const { engine, recognizers } = setup(['Ali', 'Ali']);
    let recognition = listen(engine, recognizers);
    for (let attempt = 0; attempt < 3; attempt++) {
        recognition.result(['yanlış']);
        assert.equal(engine.snapshot().stats.incorrect, 1);
        recognition.ended();
        engine.retryWord();
        recognition = recognizers.at(-1);
        recognition.started();
    }
    recognition.result(['Ali']);
    assert.equal(engine.snapshot().stats.correct, 1);
    assert.equal(engine.snapshot().stats.incorrect, 0);
});

test('skip advances one position and tracks skipped words separately, including duplicates', () => {
    const { engine, recognizers } = setup(['Ali', 'Ali']);
    let recognition = listen(engine, recognizers);
    recognition.result(['yanlış']);
    engine.skipWord();
    engine.skipWord();
    assert.equal(engine.snapshot().index, 1);
    assert.deepEqual(engine.snapshot().stats, {
        total: 2, correct: 0, incorrect: 1, skipped: 1, unread: 1,
        processed: 1, accuracy: 0, completed: false,
    });
    recognition.ended();
    recognition = recognizers[1];
    recognition.started();
    recognition.result(['yanlış']);
    recognition.ended();
    const state = engine.snapshot();
    assert.deepEqual(state.words.filter((_, i) => ['incorrect', 'skipped'].includes(state.outcomes[i])), ['Ali', 'Ali']);
    engine.skipWord();
    assert.equal(engine.snapshot().phase, 'completed');
    assert.equal(engine.snapshot().stats.skipped, 2);
    assert.equal(engine.snapshot().stats.incorrect, 2);
    assert.equal(engine.snapshot().stats.correct + engine.snapshot().stats.incorrect + engine.snapshot().stats.unread, 2);
    assert.equal(engine.snapshot().stats.completed, true);
    assert.equal(recognizers.length, 2);
});

test('skip of final word before onend completes only after the microphone stops', () => {
    const { engine, recognizers, changes } = setup(['Ali']);
    const recognition = listen(engine, recognizers);
    recognition.result(['yanlış']);
    engine.skipWord();
    assert.equal(engine.snapshot().phase, 'stopping');
    assert.equal(engine.snapshot().stats.completed, true);
    assert.equal(changes.some(state => state.phase === 'completed'), false);
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'completed');
    assert.equal(recognizers.length, 1);
});

test('final correct word stops recognition, ignores trailing events, and allows a fresh complete retry', () => {
    const { engine, recognizers } = setup(['Ali']);
    const first = listen(engine, recognizers);
    first.result(['Ali fazladan']);
    engine.pause();
    engine.start();
    first.error('no-speech');
    first.result(['Ali', 'Ali'], 1);
    assert.equal(first.stopCalls, 1);
    assert.equal(engine.snapshot().stats.correct, 1);
    first.ended();
    assert.equal(engine.snapshot().phase, 'completed');
    engine.start();
    assert.equal(recognizers.length, 2);
    assert.equal(engine.snapshot().index, 0);
    assert.equal(engine.snapshot().stats.correct, 0);
    first.started();
    first.error('network');
    first.result(['yanlış']);
    first.ended();
    assert.equal(engine.snapshot().phase, 'starting');
    assert.equal(engine.snapshot().index, 0);
});

test('microphone errors retain progress and resume only after onend', () => {
    const { engine, recognizers } = setup();
    const first = listen(engine, recognizers);
    first.result(['Ali']);
    first.error('network');
    assert.equal(engine.snapshot().phase, 'error');
    assert.equal(engine.snapshot().error, 'network');
    assert.equal(first.abortCalls, 1);
    first.error('aborted');
    assert.equal(engine.snapshot().error, 'network');
    engine.start();
    engine.start();
    assert.equal(recognizers.length, 1);
    first.result(['Ali', 'okula gitti'], 1);
    assert.equal(engine.snapshot().index, 1);
    first.ended();
    assert.equal(recognizers.length, 2);
    assert.equal(engine.snapshot().error, null);
    recognizers[1].started();
    recognizers[1].result(['okula gitti']);
    recognizers[1].ended();
    assert.equal(engine.snapshot().phase, 'completed');
});

test('permission denial before onstart is recoverable after its terminal event', () => {
    const { engine, recognizers } = setup();
    engine.start();
    recognizers[0].error('not-allowed');
    recognizers[0].ended();
    assert.equal(engine.snapshot().phase, 'error');
    assert.equal(engine.snapshot().error, 'not-allowed');
    const recognition = listen(engine, recognizers);
    assert.equal(engine.snapshot().phase, 'listening');
    recognition.result(['Ali']);
    assert.equal(engine.snapshot().index, 1);
});

test('new document invalidates stale callbacks while still awaiting old onend', () => {
    const { engine, recognizers } = setup();
    const old = listen(engine, recognizers);
    old.result(['Ali']);
    engine.load(['Yeni', 'metin']);
    engine.start();
    assert.equal(old.stopCalls, 1);
    old.result(['Ali', 'yanlış'], 1);
    old.error('not-allowed');
    old.started();
    assert.deepEqual(engine.snapshot().outcomes, ['pending', 'pending']);
    assert.equal(engine.snapshot().error, null);
    assert.equal(recognizers.length, 1);
    old.ended();
    assert.equal(recognizers.length, 2);
    const current = recognizers[1];
    current.started();
    old.result(['yanlış']);
    old.ended();
    assert.equal(engine.snapshot().phase, 'listening');
    current.result(['yeni metin']);
    current.ended();
    assert.equal(engine.snapshot().phase, 'completed');
    assert.equal(engine.snapshot().stats.correct, 2);
});

test('document replacement before onstart stops the old session without accepting its words', () => {
    const { engine, recognizers } = setup(['Eski']);
    engine.start();
    const old = recognizers[0];
    engine.load(['Yeni']);
    engine.start();
    old.started();
    assert.equal(old.stopCalls, 1);
    old.result(['Eski']);
    assert.deepEqual(engine.snapshot().outcomes, ['pending']);
    old.ended();
    assert.equal(recognizers.length, 2);
    recognizers[1].started();
    recognizers[1].result(['Yeni']);
    recognizers[1].ended();
    assert.equal(engine.snapshot().phase, 'completed');
});

test('a stop exception falls back to abort and its expected error preserves the queued retry', () => {
    const { engine, recognizers } = setup(['Ali']);
    const recognition = listen(engine, recognizers);
    recognition.stop = () => { throw new DOMException('Synthetic stopped session', 'InvalidStateError'); };
    recognition.result(['yanlış']);
    assert.equal(recognition.abortCalls, 1);
    engine.retryWord();
    recognition.error('aborted');
    assert.equal(engine.snapshot().error, null);
    recognition.ended();
    assert.equal(recognizers.length, 2);
    recognizers[1].started();
    recognizers[1].result(['Ali']);
    recognizers[1].ended();
    assert.equal(engine.snapshot().stats.correct, 1);
});

test('unexpected aborted errors are visible and do not turn partial reading into a report', () => {
    const { engine, recognizers } = setup();
    const recognition = listen(engine, recognizers);
    recognition.result(['Ali']);
    recognition.error('aborted');
    recognition.ended();
    assert.equal(engine.snapshot().phase, 'error');
    assert.equal(engine.snapshot().error, 'aborted');
    assert.equal(engine.snapshot().stats.completed, false);
    assert.equal(engine.snapshot().index, 1);
    listen(engine, recognizers);
    assert.equal(engine.snapshot().phase, 'listening');
});

test('a synchronous start failure does not poison the next recognition session', () => {
    let attempts = 0;
    const engine = new ReadingEngine({
        createRecognition: () => {
            const recognition = new FakeRecognition();
            if (attempts++ === 0) recognition.start = () => { throw new DOMException('Synthetic denial', 'NotAllowedError'); };
            return recognition;
        },
    });
    engine.load(['Ali']);
    engine.start();
    assert.equal(engine.snapshot().phase, 'error');
    assert.equal(engine.snapshot().error, 'not-allowed');
    engine.start();
    assert.equal(engine.snapshot().phase, 'starting');
    assert.equal(engine.snapshot().error, null);
});

test('unsupported browsers retain text without attempting recognition', () => {
    const engine = new ReadingEngine();
    engine.load(['Ali', '...', 'gitti']);
    engine.start();
    engine.pause();
    engine.retryWord();
    engine.skipWord();
    assert.equal(engine.snapshot().phase, 'unsupported');
    assert.deepEqual(engine.snapshot().words, ['Ali', 'gitti']);
    assert.equal(engine.snapshot().stats.unread, 2);
    assert.equal(engine.snapshot().stats.completed, false);
});

test('empty and punctuation-only text cannot produce a completed report', () => {
    const { engine, recognizers } = setup(['...', '—']);
    engine.start();
    assert.equal(recognizers.length, 0);
    assert.equal(engine.snapshot().stats.total, 0);
    assert.equal(engine.snapshot().stats.completed, false);
});

test('snapshot copies prevent views from mutating the engine', () => {
    const { engine } = setup(['Ali']);
    const snapshot = engine.snapshot();
    snapshot.words[0] = 'değişti';
    snapshot.outcomes[0] = 'correct';
    assert.deepEqual(engine.snapshot().words, ['Ali']);
    assert.deepEqual(engine.snapshot().outcomes, ['pending']);
});
