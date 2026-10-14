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
    const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
    const supported = Boolean(Recognition) && win.isSecureContext;
    let uploading = false;
    let uploadNumber = 0;
    let uploadController;
    let currentFontSize = 26;
    let displayedWords = [];
    let previousPhase;
    let previousCorrection = false;
    let modalReturnFocus;
    let engine;

    get('microphoneHelp').textContent = !win.isSecureContext
        ? 'Mikrofonu kullanmak için bu sayfayı güvenli bir HTTPS bağlantısıyla açın.'
        : !Recognition
            ? 'Bu tarayıcı sesli okumayı desteklemiyor. Chrome gibi konuşma tanımayı destekleyen bir tarayıcı deneyin. Dosyanızdaki metni yine görüntüleyebilirsiniz.'
            : 'Okumaya başlarken tarayıcının mikrofon iznine izin verin. Konuşma tanıma, tarayıcıya bağlı olarak internet bağlantısı gerektirebilir.';

    function announce(message) { status.textContent = message; }

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
        doc.querySelector('.container').inert = false;
        if (restoreFocus) {
            const target = modalReturnFocus?.isConnected && modalReturnFocus.tabIndex >= 0 && !modalReturnFocus.disabled
                && modalReturnFocus.getClientRects().length > 0 ? modalReturnFocus : startButton;
            target.focus();
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
        get('resultSummary').textContent = 'Metnin tamamını bitirdiniz! Atlanan kelimeleri yeniden çalışabilirsiniz.';
        const practiceWords = snapshot.words.filter((_, i) => ['incorrect', 'skipped'].includes(snapshot.outcomes[i]));
        get('incorrectWordsContainer').hidden = practiceWords.length === 0;
        get('incorrectWordsList').textContent = practiceWords.join(', ');
        modalReturnFocus = doc.activeElement;
        modal.hidden = false;
        modal.classList.add('visible');
        doc.querySelector('.container').inert = true;
        closeButton.focus();
    }

    function render(snapshot) {
        renderWords(snapshot);
        const hasWords = snapshot.words.length > 0;
        const busy = ['starting', 'stopping'].includes(snapshot.phase);
        const correction = snapshot.correctionPending || snapshot.phase === 'correction';
        startButton.disabled = uploading || !supported || !hasWords || busy || correction;
        resetButton.disabled = uploading || !hasWords || ['starting', 'listening', 'stopping'].includes(snapshot.phase);
        const labels = {
            ready: 'Okumaya Başla', starting: 'Mikrofon Açılıyor…', listening: 'Okumayı Durdur',
            stopping: 'Mikrofon Kapanıyor…', correction: 'Kelimeyi Düzelt', paused: 'Devam Et',
            error: 'Yeniden Dene', completed: 'Baştan Oku', unsupported: 'Sesli Okuma Desteklenmiyor'
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
                unsupported: get('microphoneHelp').textContent
            };
            announce(messages[snapshot.phase] || messages.ready);
            if (correction && !previousCorrection) retryButton.focus();
            if (snapshot.phase === 'completed' && previousPhase !== 'completed') showResults(snapshot);
        }
        previousPhase = snapshot.phase;
        previousCorrection = correction;
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
        startButton.focus();
    });
    retryButton.addEventListener('click', () => { win.speechSynthesis?.cancel(); engine.retryWord(); });
    skipButton.addEventListener('click', () => { win.speechSynthesis?.cancel(); engine.skipWord(); });
    closeButton.addEventListener('click', () => closeResults());
    retryIncorrect.addEventListener('click', () => {
        const snapshot = engine.snapshot();
        const words = snapshot.words.filter((_, i) => ['incorrect', 'skipped'].includes(snapshot.outcomes[i]));
        closeResults(false);
        engine.load(words);
        startButton.focus();
    });
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeResults(); }
        if (event.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button')].filter(button => !button.disabled && !button.closest('[hidden]'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
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
