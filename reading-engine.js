/** Shared normalization for document words and recognition transcripts. */
export function normalizeWord(word) {
    return String(word)
        .normalize('NFC')
        .toLocaleLowerCase('tr-TR')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

export function tokenizeText(text) {
    return String(text).normalize('NFC').split(/\s+/u).filter(word => normalizeWord(word));
}

/**
 * SpeechRecognition lifecycle without DOM dependencies.
 * A recognizer belongs to one session; a replacement starts only after onend.
 */
export class ReadingEngine {
    constructor({ createRecognition, onChange = () => {} } = {}) {
        this._createRecognition = createRecognition;
        this._onChange = onChange;
        this._documentVersion = 0;
        this._active = null;
        this.words = [];
        this.outcomes = [];
        this.index = 0;
        this.correctionPending = false;
        this.error = null;
        this.phase = typeof createRecognition === 'function' ? 'ready' : 'unsupported';
    }

    load(words) {
        this._documentVersion++;
        this.words = [...words].filter(word => typeof word === 'string' && normalizeWord(word));
        this._resetProgress();
        const nextPhase = typeof this._createRecognition === 'function' ? 'ready' : 'unsupported';
        if (this._active) {
            this._active.nextAction = nextPhase;
            this._active.acceptsResults = false;
            this.phase = 'stopping';
            this._publish();
            this._requestStop(this._active);
        } else {
            this.phase = nextPhase;
            this._publish();
        }
    }

    start() {
        if (this.phase === 'unsupported' || !this.words.length || this.correctionPending) return;
        if (this.phase === 'completed') this._resetProgress();
        if (this._active) {
            // A click while starting/listening must never call start twice.
            if (!this._active.stopRequested && this._active.documentVersion === this._documentVersion) return;
            if (this.index === this.words.length) return;
            this._active.nextAction = 'start';
            this.phase = 'stopping';
            this._publish();
            return;
        }
        this._begin();
    }

    pause() {
        if (!this._active) return;
        if (this._active.nextAction === 'completed') return;
        this._active.nextAction = this.correctionPending ? 'correction' : 'paused';
        this._active.acceptsResults = false;
        this.phase = 'stopping';
        this._publish();
        this._requestStop(this._active);
    }

    retryWord() {
        if (!this.correctionPending || this.outcomes[this.index] !== 'incorrect') return;
        this.outcomes[this.index] = 'pending';
        this.correctionPending = false;
        this.error = null;
        this._continueAfterCorrection();
    }

    skipWord() {
        if (!this.correctionPending || this.outcomes[this.index] !== 'incorrect') return;
        this.outcomes[this.index] = 'skipped';
        this.index++;
        this.correctionPending = false;
        this.error = null;
        this._continueAfterCorrection();
    }

    snapshot() {
        const count = outcome => this.outcomes.filter(value => value === outcome).length;
        const total = this.words.length;
        const correct = count('correct');
        return {
            phase: this.phase,
            words: [...this.words],
            outcomes: [...this.outcomes],
            index: this.index,
            correctionPending: this.correctionPending,
            error: this.error,
            stats: {
                total,
                correct,
                // Skipping a failed word must not erase its error. Skipped is
                // a subset of incorrect, not an extra term in the total.
                incorrect: count('incorrect') + count('skipped'),
                skipped: count('skipped'),
                unread: count('pending'),
                processed: this.index,
                accuracy: total ? Math.round(correct / total * 100) : 0,
                completed: total > 0 && this.index === total,
            },
        };
    }

    _resetProgress() {
        this.outcomes = this.words.map(() => 'pending');
        this.index = 0;
        this.correctionPending = false;
        this.error = null;
    }

    _publish() {
        this._onChange(this.snapshot());
    }

    _begin() {
        let recognition;
        try {
            recognition = this._createRecognition();
            if (!recognition || typeof recognition.start !== 'function') {
                this.phase = 'unsupported';
                this._publish();
                return;
            }
            recognition.lang = 'tr-TR';
            recognition.continuous = true;
            recognition.interimResults = false;
        } catch (error) {
            this._failToStart(error);
            return;
        }

        const session = {
            recognition,
            documentVersion: this._documentVersion,
            finalizedResults: new Set(),
            hasStarted: false,
            stopRequested: false,
            stopSent: false,
            acceptsResults: true,
            nextAction: null,
        };
        this._active = session;
        recognition.onstart = () => this._handleStart(session);
        recognition.onresult = event => this._handleResult(session, event);
        recognition.onerror = event => this._handleError(session, event);
        recognition.onend = () => this._handleEnd(session);
        this.error = null;
        this.phase = 'starting';
        this._publish();
        try {
            recognition.start();
        } catch (error) {
            // A synchronous start failure has no running session to await.
            if (this._active === session) {
                this._active = null;
                this._failToStart(error);
            }
        }
    }

    _failToStart(error) {
        const names = { NotAllowedError: 'not-allowed', InvalidStateError: 'invalid-state', NotSupportedError: 'not-supported' };
        this.error = names[error?.name] || 'start-failed';
        this.phase = 'error';
        this._publish();
    }

    _isCurrent(session) {
        return this._active === session && session.documentVersion === this._documentVersion;
    }

    _handleStart(session) {
        if (this._active !== session) return;
        session.hasStarted = true;
        if (session.stopRequested || !this._isCurrent(session)) {
            this._requestStop(session);
            return;
        }
        this.phase = 'listening';
        this._publish();
    }

    _handleResult(session, event) {
        if (!this._isCurrent(session) || !session.acceptsResults || this.phase !== 'listening') return;
        const firstResult = Number.isInteger(event.resultIndex) ? Math.max(0, event.resultIndex) : 0;
        for (let resultIndex = firstResult; resultIndex < event.results.length; resultIndex++) {
            const result = event.results[resultIndex];
            if (!result?.isFinal || session.finalizedResults.has(resultIndex)) continue;
            session.finalizedResults.add(resultIndex);
            if (typeof result[0]?.transcript !== 'string') continue;
            for (const word of tokenizeText(result[0].transcript)) {
                if (this.index >= this.words.length) return;
                if (normalizeWord(word) === normalizeWord(this.words[this.index])) {
                    this.outcomes[this.index] = 'correct';
                    this.index++;
                    if (this.index === this.words.length) {
                        this._finish(session);
                        return;
                    }
                } else {
                    this.outcomes[this.index] = 'incorrect';
                    this.correctionPending = true;
                    session.acceptsResults = false;
                    session.nextAction = 'correction';
                    this.phase = 'stopping';
                    this._publish();
                    this._requestStop(session);
                    return;
                }
            }
        }
        this._publish();
    }

    _continueAfterCorrection() {
        const nextAction = this.index === this.words.length ? 'completed' : 'start';
        if (this._active) {
            this._active.nextAction = nextAction;
            this._active.acceptsResults = false;
            this.phase = 'stopping';
            this._publish();
            this._requestStop(this._active);
        } else if (nextAction === 'completed') {
            this.phase = 'completed';
            this._publish();
        } else {
            this._begin();
        }
    }

    _finish(session) {
        session.acceptsResults = false;
        session.nextAction = 'completed';
        this.phase = 'stopping';
        this._publish();
        this._requestStop(session);
    }

    _requestStop(session) {
        if (this._active !== session) return;
        session.stopRequested = true;
        // If pause/load happens before onstart, stop as soon as onstart arrives.
        if (!session.hasStarted || session.stopSent) return;
        session.stopSent = true;
        try {
            session.recognition.stop();
        } catch (error) {
            try {
                session.recognition.abort();
            } catch {
                if (this._isCurrent(session)) {
                    session.nextAction = 'error';
                    this.error = 'stop-failed';
                    this.phase = 'error';
                    this._publish();
                }
            }
        }
    }

    _handleError(session, event) {
        if (!this._isCurrent(session)) return;
        if (session.nextAction === 'completed') return;
        // An abort requested by this engine is not a new microphone failure.
        if (event.error === 'aborted' && session.stopRequested) return;
        session.acceptsResults = false;
        session.nextAction = 'error';
        this.error = event.error || 'unknown';
        this.phase = 'error';
        this._publish();
        if (!session.stopSent) {
            session.stopRequested = true;
            session.stopSent = true;
            try {
                if (typeof session.recognition.abort === 'function') session.recognition.abort();
                else session.recognition.stop();
            } catch {
                // Speech API errors end the session; onend releases ownership.
            }
        }
    }

    _handleEnd(session) {
        if (this._active !== session) return;
        this._active = null;
        const nextAction = session.nextAction;
        if (nextAction === 'start') {
            this._begin();
            return;
        }
        if (nextAction) {
            this.phase = nextAction;
        } else if (this.correctionPending) {
            this.phase = 'correction';
        } else {
            // An unexpected onend preserves unread words and never reports completion.
            this.phase = 'paused';
        }
        this._publish();
    }
}
