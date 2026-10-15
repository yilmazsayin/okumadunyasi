import { ReadingEngine, normalizeWord, tokenizeText } from './reading-engine.js';

export const UPLOAD_URL = 'https://okumadunyasi-api.onrender.com/upload';
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_TIMEOUT = 90_000; // Allow for a Render cold start, but never wait forever.

export function validateFile(file) {
    if (!file || !/\.docx$/i.test(file.name)) return 'Lütfen .docx uzantılı bir Word dosyası seçin.';
    if (file.size === 0) return 'Bu dosya boş görünüyor. Başka bir Word dosyası seçin.';
    if (file.size > MAX_FILE_SIZE) return 'Dosya çok büyük. En fazla 10 MB boyutunda bir Word dosyası seçin.';
    return null;
}

export const microphoneMessages = {
    'not-allowed': 'Mikrofon izni verilmedi. Tarayıcının site ayarlarından mikrofon iznini açıp yeniden deneyin.',
    'service-not-allowed': 'Tarayıcı konuşma tanımaya izin vermiyor. Destekleyen bir tarayıcıda yeniden deneyin.',
    'audio-capture': 'Mikrofon bulunamadı. Mikrofon bağlantısını ve cihaz ayarlarını kontrol edin.',
    'no-speech': 'Ses duyulamadı. Hazır olduğunuzda Devam Et ile yeniden deneyin.',
    network: 'Konuşma hizmetine bağlanılamadı. İnternet bağlantısını kontrol edip yeniden deneyin.',
    aborted: 'Mikrofon durduruldu. Hazır olduğunuzda okumaya devam edebilirsiniz.',
    'language-not-supported': 'Bu tarayıcı Türkçe konuşma tanımayı desteklemiyor. Başka bir tarayıcı deneyin.'
};

export function initApp(doc = document, win = window) {
    const get = id => doc.getElementById(id);
    const startButton = get('baslatBtn');
    const resetButton = get('resetReadingBtn');
    const finishButton = get('finishReadingBtn');
    const readingArea = get('okuma-alani');
    const status = get('durum');
    const fileInput = get('file-input');
    const uploadArea = get('file-upload-area');
    const correctionBox = get('correction-box');
    const retryButton = get('retry-word-btn');
    const skipButton = get('skip-word-btn');
    const progress = get('progressContainer');
    const modal = get('sonucModal');
    const closeButton = get('modalKapatBtn');
    const retryIncorrect = get('retryIncorrectBtn');
    const restartButton = get('restartReadingBtn');
    const readingControls = doc.querySelector('.reading-controls');
    const modalContent = modal.querySelector('.modal-content');
    const container = doc.querySelector('.container');
    const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    const supported = Boolean(Recognition) && win.isSecureContext;
    let uploading = false;
    let uploadNumber = 0;
    let uploadController;
    let currentFontSize = 26;
    let displayedWords = [];
    let previousPhase;
    let previousCorrection = false;
    let previousWordIndex = -1;
    let modalReturnFocus;
    let modalScrollState;
    let engine;

    get('microphoneHelp').textContent = !win.isSecureContext
        ? 'Mikrofonu kullanmak için bu sayfayı güvenli bir HTTPS bağlantısıyla açın.'
        : !Recognition
            ? 'Bu tarayıcı sesli okumayı desteklemiyor. Chrome gibi konuşma tanımayı destekleyen bir tarayıcı deneyin. Dosyanızdaki metni yine görüntüleyebilirsiniz.'
            : 'Okumaya başlarken tarayıcının mikrofon iznine izin verin. Konuşma tanıma, tarayıcıya bağlı olarak internet bağlantısı gerektirebilir.';

    function announce(message) { status.textContent = message; }

    function focusWithoutScroll(element) { element?.focus({ preventScroll: true }); }

    function focusInPanel(element, panel) {
        focusWithoutScroll(element);
        const rect = element.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        // Keyboard navigation may scroll the panel, never the page behind it.
        if (rect.bottom > bounds.bottom - 8) panel.scrollTop += rect.bottom - bounds.bottom + 8;
        else if (rect.top < bounds.top + 8) panel.scrollTop += rect.top - bounds.top - 8;
    }

    function isVisibleControl(element) {
        if (!element?.isConnected || element.disabled || element.closest('[hidden]')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= win.innerHeight
            && rect.left >= 0 && rect.right <= win.innerWidth;
    }

    function currentWord(snapshot = engine.snapshot()) {
        return get(`kelime-${Math.min(snapshot.index, snapshot.words.length - 1)}`);
    }

    function revealCurrentWord(snapshot = engine.snapshot()) {
        if (!modal.hidden) return;
        const word = currentWord(snapshot);
        if (!word) return;
        const bar = readingControls.getBoundingClientRect();
        const top = Math.max(12, Math.min(win.innerHeight / 2, bar.bottom + 8));
        const bottom = correctionBox.hidden ? win.innerHeight - 12 : correctionBox.getBoundingClientRect().top - 8;
        const rect = word.getBoundingClientRect();
        // Only move enough to reveal this word. Never follow manual scrolling.
        const delta = rect.top < top ? rect.top - top
            : rect.bottom > bottom ? Math.min(rect.bottom - bottom, rect.top - top) : 0;
        if (Math.abs(delta) > 1) win.scrollBy(0, delta);
    }

    function focusReadingControl() {
        if (!modal.hidden) return;
        focusWithoutScroll([startButton, finishButton, resetButton, currentWord()].find(isVisibleControl) || readingArea);
    }

    function rememberStyles(element, properties) {
        return properties.map(property => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
    }

    function restoreStyles(element, styles) {
        for (const [property, value, priority] of styles) {
            if (value) element.style.setProperty(property, value, priority);
            else element.style.removeProperty(property);
        }
    }

    function lockPageScroll() {
        if (modalScrollState) return;
        const scrollbarWidth = win.innerWidth - doc.documentElement.clientWidth;
        modalScrollState = {
            x: win.scrollX, y: win.scrollY, inert: container.inert,
            body: rememberStyles(doc.body, ['position', 'top', 'left', 'width', 'overflow-x', 'overflow-y', 'padding-right']),
            html: rememberStyles(doc.documentElement, ['overflow-x', 'overflow-y'])
        };
        // Fixed body also prevents touch scrolling on mobile browsers. Preserve
        // the visual page offset, including existing inline styles and gutters.
        const padding = parseFloat(win.getComputedStyle(doc.body).paddingRight) || 0;
        doc.body.style.position = 'fixed';
        doc.body.style.top = `${-modalScrollState.y}px`;
        doc.body.style.left = `${-modalScrollState.x}px`;
        doc.body.style.width = '100%';
        doc.body.style.overflow = 'hidden';
        if (scrollbarWidth > 0) doc.body.style.paddingRight = `${padding + scrollbarWidth}px`;
        doc.documentElement.style.overflow = 'hidden';
        container.inert = true;
    }

    function unlockPageScroll() {
        if (!modalScrollState) return;
        const saved = modalScrollState;
        modalScrollState = null;
        restoreStyles(doc.body, saved.body);
        restoreStyles(doc.documentElement, saved.html);
        container.inert = saved.inert;
        win.scrollTo(saved.x, saved.y);
    }

    function speakWord(word) {
        if (uploading || ['starting', 'listening', 'stopping'].includes(engine.snapshot().phase)) return;
        if (!win.speechSynthesis || !win.SpeechSynthesisUtterance) {
            announce('Bu tarayıcı kelimeleri seslendirmeyi desteklemiyor.');
            return;
        }
        try {
            win.speechSynthesis.cancel();
            const utterance = new win.SpeechSynthesisUtterance(word.normalize('NFC'));
            utterance.lang = 'tr-TR';
            utterance.onerror = () => announce('Kelime seslendirilemedi. Cihazın ses ayarlarını kontrol edin.');
            win.speechSynthesis.speak(utterance);
        } catch {
            announce('Kelime seslendirilemedi. Başka bir tarayıcıda deneyin.');
        }
    }

    function renderWords(snapshot) {
        if (displayedWords.length !== snapshot.words.length || displayedWords.some((word, i) => word !== snapshot.words[i])) {
            const fragment = doc.createDocumentFragment();
            snapshot.words.forEach((word, index) => {
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'word-button';
                button.id = `kelime-${index}`;
                button.textContent = word; // DOCX text must never be interpreted as HTML.
                button.setAttribute('aria-label', `${word} kelimesini dinle`);
                button.addEventListener('click', () => speakWord(word));
                fragment.append(button, doc.createTextNode(' '));
            });
            readingArea.replaceChildren(fragment);
            displayedWords = [...snapshot.words];
        }
        snapshot.outcomes.forEach((outcome, index) => {
            const word = get(`kelime-${index}`);
            word.className = `word-button${outcome === 'pending' ? '' : ` ${outcome}`}`;
            word.disabled = uploading || ['starting', 'listening', 'stopping'].includes(snapshot.phase);
            if (index === snapshot.index) word.setAttribute('aria-current', 'true');
            else word.removeAttribute('aria-current');
        });
    }

    function closeResults(restoreFocus = true) {
        modal.hidden = true;
        modal.classList.remove('visible');
        unlockPageScroll();
        if (restoreFocus) {
            const target = [modalReturnFocus, startButton, currentWord(), finishButton, resetButton]
                .find(element => element?.tabIndex >= 0 && isVisibleControl(element));
            focusWithoutScroll(target || readingArea);
        }
    }

    function showResults(snapshot) {
        const stats = snapshot.stats;
        get('totalWords').textContent = stats.total;
        get('correctWords').textContent = stats.correct;
        get('incorrectWords').textContent = stats.incorrect;
        get('skippedWords').textContent = stats.skipped;
        get('unreadWords').textContent = stats.unread;
        get('accuracy').textContent = `%${stats.accuracy}`;
        get('resultSummary').textContent = snapshot.finishedEarly
            ? 'Okuma erken sonlandırıldı. Henüz okunmayan kelimeler hata sayısına eklenmedi. İsterseniz yeniden başlayabilirsiniz.'
            : 'Metnin tamamını bitirdiniz! Atlanan kelimeleri yeniden çalışabilirsiniz.';
        const practiceWords = snapshot.words.filter((_, i) => ['incorrect', 'skipped'].includes(snapshot.outcomes[i]));
        get('incorrectWordsContainer').hidden = practiceWords.length === 0;
        get('incorrectWordsList').textContent = practiceWords.join(', ');
        modalReturnFocus = doc.activeElement;
        lockPageScroll();
        modal.hidden = false;
        modal.classList.add('visible');
        modalContent.scrollTop = 0;
        get('incorrectWordsList').scrollTop = 0;
        focusWithoutScroll(closeButton);
    }

    function render(snapshot) {
        renderWords(snapshot);
        const hasWords = snapshot.words.length > 0;
        const busy = ['starting', 'stopping'].includes(snapshot.phase);
        const correction = snapshot.correctionPending || snapshot.phase === 'correction';
        startButton.disabled = uploading || !supported || !hasWords || busy || correction;
        resetButton.disabled = uploading || !hasWords || ['starting', 'listening', 'stopping'].includes(snapshot.phase);
        finishButton.disabled = uploading || !hasWords || snapshot.finishedEarly || snapshot.stats.completed;
        const labels = {
            ready: 'Okumaya Başla', starting: 'Mikrofon Açılıyor…', listening: 'Okumayı Durdur',
            stopping: 'Mikrofon Kapanıyor…', correction: 'Kelimeyi Düzelt', paused: 'Devam Et',
            error: 'Yeniden Dene', completed: 'Baştan Oku', 'finished-early': 'Baştan Oku',
            unsupported: 'Sesli Okuma Desteklenmiyor'
        };
        startButton.textContent = labels[snapshot.phase] || 'Okumaya Başla';
        startButton.setAttribute('aria-pressed', String(snapshot.phase === 'listening'));
        const percentage = hasWords ? Math.round(snapshot.stats.processed / snapshot.stats.total * 100) : 0;
        progress.hidden = !hasWords;
        progress.setAttribute('aria-valuenow', percentage);
        progress.setAttribute('aria-valuetext', `${snapshot.stats.processed} / ${snapshot.stats.total} kelime`);
        get('progressBar').style.width = `${percentage}%`;
        get('progressText').hidden = !hasWords;
        get('progressText').textContent = hasWords ? `${snapshot.stats.processed} / ${snapshot.stats.total} kelime tamamlandı` : '';
        correctionBox.hidden = !correction || uploading;
        retryButton.disabled = !correction || uploading;
        skipButton.disabled = !correction || uploading;
        if (correction) get('correctionMessage').textContent = `“${snapshot.words[snapshot.index]}” kelimesini tekrar okuyun veya atlayın.`;
        if (!uploading) {
            const messages = {
                ready: hasWords ? 'Metin hazır. Okumaya başlayabilirsiniz.' : 'Bir Word dosyası seçerek başlayın.',
                starting: 'Mikrofon açılıyor. İstenirse mikrofon izni verin.',
                listening: 'Mikrofon dinliyor. Sıradaki kelimeleri okuyun.',
                stopping: 'Mikrofon kapanıyor…',
                correction: 'Mikrofon durduruldu. Tekrar Oku veya Atla seçeneğini kullanın.',
                paused: 'Mikrofon durduruldu. Devam Et ile kaldığınız yerden okuyabilirsiniz.',
                error: (microphoneMessages[snapshot.error] || 'Mikrofon başlatılamadı. İzinleri kontrol edip yeniden deneyin.')
                    + (correction ? ' Bu kelime için Tekrar Oku veya Atla seçeneğini kullanın.' : ''),
                completed: 'Okuma tamamlandı. Raporunuz hazır.',
                'finished-early': 'Okuma erken sonlandırıldı. Raporunuz hazır.',
                unsupported: get('microphoneHelp').textContent
            };
            announce(messages[snapshot.phase] || messages.ready);
            if ((correction && !previousCorrection) || (snapshot.phase === 'listening'
                && (previousPhase !== 'listening' || previousWordIndex !== snapshot.index))) revealCurrentWord(snapshot);
            if (correction && !previousCorrection) focusInPanel(retryButton, correctionBox);
            if (['completed', 'finished-early'].includes(snapshot.phase) && previousPhase !== snapshot.phase) showResults(snapshot);
            // An upload may temporarily hide a pending report. Do not consume
            // its terminal transition unless the report can actually be shown.
            previousPhase = snapshot.phase;
        }
        previousCorrection = correction;
        previousWordIndex = snapshot.index;
    }

    engine = new ReadingEngine({
        createRecognition: supported ? () => new Recognition() : null,
        onChange: render
    });
    render(engine.snapshot());

    startButton.addEventListener('click', () => {
        win.speechSynthesis?.cancel();
        if (engine.snapshot().phase === 'listening') engine.pause();
        else engine.start();
    });
    resetButton.addEventListener('click', () => {
        closeResults(false);
        engine.load(engine.snapshot().words);
        revealCurrentWord();
        focusReadingControl();
    });
    finishButton.addEventListener('click', () => {
        win.speechSynthesis?.cancel();
        engine.finishEarly();
    });
    restartButton.addEventListener('click', () => {
        closeResults(false);
        win.speechSynthesis?.cancel();
        engine.load(engine.snapshot().words);
        if (supported) engine.start();
        revealCurrentWord();
        focusReadingControl();
    });
    retryButton.addEventListener('click', () => {
        win.speechSynthesis?.cancel(); engine.retryWord();
        revealCurrentWord(); focusReadingControl();
    });
    skipButton.addEventListener('click', () => {
        win.speechSynthesis?.cancel(); engine.skipWord();
        revealCurrentWord(); focusReadingControl();
    });
    closeButton.addEventListener('click', () => closeResults());
    retryIncorrect.addEventListener('click', () => {
        const snapshot = engine.snapshot();
        const words = snapshot.words.filter((_, i) => ['incorrect', 'skipped'].includes(snapshot.outcomes[i]));
        closeResults(false);
        engine.load(words);
        revealCurrentWord();
        focusReadingControl();
    });
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeResults(); }
        if (event.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button')].filter(button => !button.disabled && !button.closest('[hidden]'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); focusInPanel(last, modalContent); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); focusInPanel(first, modalContent); }
    });

    function applyFontSize(size) { currentFontSize = size; readingArea.style.fontSize = `${size}px`; }
    get('fontIncreaseBtn').addEventListener('click', () => applyFontSize(Math.min(48, currentFontSize + 2)));
    get('fontDecreaseBtn').addEventListener('click', () => applyFontSize(Math.max(14, currentFontSize - 2)));
    get('fontResetBtn').addEventListener('click', () => applyFontSize(26));

    async function uploadFile(file) {
        const validationMessage = validateFile(file);
        if (validationMessage) { announce(validationMessage); return; }
        const requestNumber = ++uploadNumber;
        uploadController?.abort();
        const controller = new AbortController();
        uploadController = controller;
        uploading = true;
        closeResults(false);
        win.speechSynthesis?.cancel();
        engine.pause();
        render(engine.snapshot());
        uploadArea.setAttribute('aria-busy', 'true');
        announce('Word dosyanız yükleniyor. Sunucunun açılması biraz zaman alabilir…');
        let timedOut = false;
        const timeout = win.setTimeout(() => { timedOut = true; controller.abort(); }, UPLOAD_TIMEOUT);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await win.fetch(UPLOAD_URL, { method: 'POST', body: formData, signal: controller.signal });
            if (requestNumber !== uploadNumber) return;
            if (!response.ok) {
                throw new Error(response.status === 413
                    ? 'Sunucu bu dosyayı çok büyük buldu. Daha küçük bir dosya seçin.'
                    : 'Dosya işlenemedi. Geçerli bir Word dosyasıyla yeniden deneyin.');
            }
            let data;
            try { data = await response.json(); }
            catch { throw new Error('Sunucudan geçerli bir yanıt alınamadı. Biraz sonra yeniden deneyin.'); }
            if (requestNumber !== uploadNumber) return;
            if (typeof data?.text !== 'string') throw new Error('Sunucu okunabilir metin göndermedi. Başka bir Word dosyası deneyin.');
            const words = tokenizeText(data.text);
            if (words.length === 0 || words.every(word => !normalizeWord(word))) {
                throw new Error('Bu dosyada okunabilecek kelime bulunamadı. Metin içeren bir Word dosyası seçin.');
            }
            uploading = false;
            applyFontSize(26);
            engine.load(words);
            announce(`${file.name} yüklendi. ${words.length} kelime okumaya hazır.${supported ? '' : ' Sesli okuma bu tarayıcıda kullanılamıyor.'}`);
        } catch (error) {
            if (requestNumber !== uploadNumber) return;
            uploading = false;
            render(engine.snapshot());
            announce(timedOut
                ? 'Sunucu zamanında yanıt vermedi. Biraz sonra yeniden deneyin.'
                : error instanceof TypeError
                    ? 'Sunucuya ulaşılamadı. İnternet bağlantısını kontrol edip yeniden deneyin.'
                    : error.message || 'Dosya yüklenemedi. Yeniden deneyin.');
        } finally {
            win.clearTimeout(timeout);
            if (requestNumber === uploadNumber) {
                uploading = false;
                uploadArea.setAttribute('aria-busy', 'false');
                uploadController = null;
                fileInput.value = ''; // Selecting the same file again must trigger change.
            }
        }
    }

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (file) uploadFile(file);
    });
    for (const eventName of ['dragenter', 'dragover']) uploadArea.addEventListener(eventName, event => {
        event.preventDefault();
        uploadArea.classList.add('drag-active');
    });
    uploadArea.addEventListener('dragleave', event => {
        if (!uploadArea.contains(event.relatedTarget)) uploadArea.classList.remove('drag-active');
    });
    uploadArea.addEventListener('drop', event => {
        event.preventDefault();
        uploadArea.classList.remove('drag-active');
        const files = event.dataTransfer?.files;
        if (files?.length !== 1) { announce('Lütfen her seferinde tek bir Word dosyası bırakın.'); return; }
        uploadFile(files[0]);
    });
    return { engine, uploadFile };
}

if (typeof document !== 'undefined') initApp();
