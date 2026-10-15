# Okuma Dünyası

[Okuma Dünyası](https://okumadunyasi.vercel.app/), ilkokul öğrencilerinin DOCX ve PDF
belgelerindeki metinlerle Türkçe okuma pratiği yapmasını sağlayan statik bir uygulamadır.

## Yerel geliştirme

Derleme ve frontend sunucu bağımlılığı yoktur. Depo kökünde:

```sh
python3 -m http.server 3000 --bind 127.0.0.1
```

`index.html`, `app.js` ve `reading-engine.js` aynı dizinden sunulmalıdır. JavaScript
yerel ES modülleri kullanır; sayfayı `file://` ile açmak yerine bir HTTP sunucusu
kullanın. Mevcut Vercel statik dosya yapısı korunur; framework veya build adımı eklenmez.
Dağıtım ayarları değiştirilmemiştir; canlı Vercel dağıtımı bu değişiklik kapsamında
test edilmemiştir.

PDF ve DOCX yüklemesi mevcut `https://okumadunyasi-api.onrender.com/upload` adresine,
`file` alanıyla `multipart/form-data` POST gönderir. Backend bu depoda bulunmaz.
Frontend `.docx` / `.pdf` uzantısını, boş dosyayı ve 10 MiB sınırını kontrol eder; bu kontroller
sunucudaki dosya doğrulamasının yerini tutmaz. İstek 90 saniyede zaman aşımına uğrar;
yeni dosya seçilirse önceki istek iptal edilir. Aynı ad/boyut/tür/değiştirilme zamanı
ile halen yüklenmekte olan dosya için ikinci istek oluşturulmaz. Başarısız yükleme
mevcut metni, değerlendirmeleri ve yazı boyutunu korur; mikrofon güvenle duraklatılır.
Her iki formatın `{ "text": "..." }` yanıtı aynı okuma motoruna aktarılır.

## Yükleme deneyimi ve PDF sınırları

- `Dosya hazırlanıyor`: dosya doğrulanıp multipart istek hazırlanır.
- `Dosya gönderiliyor / Sunucudan yanıt bekleniyor`: `fetch` isteği devam eder.
  Gönderim ile sunucudaki çıkarma işlemi ayrı ayrı ölçülemediğinden birlikte belirtilir.
- `Metin hazırlanıyor`: gelen JSON yanıtı okunup kelimelere ayrılır.
- `Metin okumaya hazır`: metin okuma alanına aktarılmıştır.

İşlem boyunca gerçek istemci süresi gösterilir. Yanıt 8 saniyeyi aşarsa sunucunun
ilk istekte uyanmasının zaman alabileceği açıklanır. Yüzde bilinmediğinden yalnızca
belirsiz işlem göstergesi kullanılır; gönderim veya backend işleme yüzdesi uydurulmaz.
Render'ın soğuk başlangıcı frontend koduyla tamamen giderilemez. İptal, sonuç ve hata
sonrasında ilgili zamanlayıcılar temizlenir; eski istek yeni dosyanın durumunu değiştiremez.
Durum metni dosya seçme alanında da görünür; ayrıntılı durum kartı küçük ekranda
aşağıda kalsa bile beklemenin sürdüğü anlaşılır. Yeni bir dosya için alan kullanılabilir kalır.

PDF'de seçilebilir metin bulunmalıdır. OCR yoktur; taranmış/fotoğraf PDF'lerde
`Bu PDF'de okunabilir metin bulunamadı. Taranmış PDF'ler henüz desteklenmiyor.`
mesajı gösterilir. Şifreli/bozuk belge ve boyut/sayfa sınırı gibi güvenli backend
`400/413/422/500` JSON `error` mesajları HTML olarak yorumlanmadan gösterilir.

## Okuma akışı ve rapor

`reading-engine.js`, DOM'dan bağımsız bir durum makinesidir. Tanıma nesnesinin
fabrikası ve değişiklik dinleyicisi dışarıdan verilebilir. `start`, `pause`,
`retryWord`, `skipWord`, `finishEarly` ve `load` işlemleri testlerde sahte olaylarla çalıştırılabilir.

- Mikrofon oturumları `starting`, `listening` ve `stopping` durumlarından geçer.
  Yeni oturum, önceki oturumun `onend` olayı gelmeden başlamaz.
- Durdurma, beklenmedik `onend` ve mikrofon hataları ilerlemeyi korur. `Devam Et` /
  `Yeniden Dene`, mevcut kelimeden sürdürür; `Metni Baştan Oku` ilerlemeyi sıfırlar.
- `Bitir ve Sonucu Gör` okumayı sonlandırır; duraklatmadan ayrı `finishEarly()`
  işlemini kullanır. Mikrofon açıksa kapanış beklenir, geç gelen tanıma sonuçları
  işlenmez. `finished-early` durumunda rapor erken sonlandırmayı açıkça belirtir.
  Mevcut doğru, hatalı ve atlanan sayıları korunur; okunmayanlar hata sayısına eklenmez.
  Raporun `Yeniden Okumaya Başla` düğmesi aynı metinle sıfırdan yeni oturum başlatır.
- İlk hatalı kelimede mikrofon durur. `Tekrar Oku` aynı konumu yeniden değerlendirir;
  başarılı tekrar bu konumu doğru yapar. `Atla` hatayı koruyarak bir konum ilerler.
- Her kelime **konumu** ayrı değerlendirilir. Aynı kelimenin farklı yerlerdeki
  tekrarları ayrı sayılır; aynı konumdaki çok sayıda deneme sayaçları şişirmez.
- `Hatalı Okunan`, halen hatalı olan veya hatalı okunup atlanan konumları içerir.
  `Atlanan`, hatalıların alt kümesidir. Toplam = doğru + hatalı + henüz okunmayan;
  atlanan sayı ikinci kez toplama eklenmez.
- İlerleme, ilerlenmiş konum / toplam konumdur. Başarı oranı doğru / toplamdır;
  yarım okuma `%100` olmaz. Otomatik rapor tüm konumlar bitip mikrofon kapandıktan
  sonra açılır. Kullanıcı erken bitirmeyi seçerse kısmi sonuç raporu açılır;
  duraklama veya beklenmedik `onend` kendiliğinden rapor açmaz.
- Yalnızca yeni kesinleşmiş tanıma sonuçları işlenir. Türkçe küçük harf dönüşümü,
  Unicode NFC ve noktalama temizliği belge ile konuşma metnine eşit uygulanır.
  Noktalama dışında harf veya rakam içermeyen parçalar okunacak kelime sayılmaz.

`app.js` belge metnini ve dosya adlarını `textContent` / DOM düğümleri ile gösterir;
HTML olarak yorumlamaz. Sürükle-bırak, Enter/Space ile dosya seçme, klavyeyle kelime
seslendirme ve raporda odak yönetimi desteklenir. Mikrofon açıkken kelime seslendirme
kontrolleri kapalıdır; uygulamanın kendi sesini okuma sonucu saymaması amaçlanır.

Uzun metinlerde okuma kontrolleri metnin yanında sticky kalır; Tekrar Oku / Atla
ekran içindeki ayrı panelde gösterilir. Odak değişimleri sayfayı kaydırmaz; sıradaki
kelime ancak gerektiğinde, kontrollerin kapatmadığı alana getirilir. Elle kaydırma
kelimeye geri zorlanmaz. Sonuç penceresi arka sayfayı mevcut konumunda kilitler;
rapor kendi içinde kaydırılır ve her açılışta baştan gösterilir. Kapatma önceki
konumu korur; yeniden başlatma ilk kelimeyi ve ilgili kontrolü görünür hale getirir.

## Testler

Node.js 18 veya üstü, npm ve tarayıcı testleri için Chromium gerekir:

```sh
npm ci
npm test
npm run test:browser
```

Tarayıcı testleri varsayılan olarak `/usr/bin/chromium` kullanır. Başka bir konum
varsa `CHROMIUM_PATH` ile belirtin. `playwright-core` yalnızca geliştirme/test
bağımlılığıdır; tarayıcı indirmez ve uygulama tarafından yüklenmez.

Birim testleri start/stop yarışlarını, erken `onend`, retry/skip, aynı kelimenin farklı
konumlarını, Türkçe normalizasyonu, hata sonrası toparlanmayı ve erken bitirmeyi kapsar. Chromium
testleri gerçek HTML/ES modülleri, güvenli metin gösterimi, API yanıt hataları, dosya
kontrolleri, eşzamanlı yükleme, sürükle-bırak, klavye odağı ve 320px taşma kontrolünü
çalıştırır. API yanıtları ve SpeechRecognition olayları sahtedir; canlı API'ye dosya
ve gerçek ses gönderilmez. Test verileri yapaydır ve kişisel bilgi içermez.
PDF/DOCX seçimi ve sürükle-bırak, güvenli hata yanıtları, yavaş backend, geçen süre,
90 saniyelik zaman aşımı, önceki isteğin iptali ve tekrar istek önleme ayrıca sınanır.
Bekleme testleri gerçek 90 saniye beklemek yerine tarayıcı saatini kontrol eder.
Uzun metin testleri ayrıca `window.scrollY`, odak ve kelime/kontrol konumlarını,
modal iç kaydırmayı, arka sayfa kilidini ve kapatıp yeniden başlama davranışlarını
masaüstünde ve 320px genişlikte kısa mobil viewportlarda doğrular.

## Gerçek cihazda yapılacak kontroller

Otomasyon gerçek mikrofon veya konuşma hizmetini doğrulamaz. HTTPS üzerinde masaüstü
Chrome ve mobil tarayıcılarda şu kontroller yapılmalıdır:

1. Mikrofon iznine izin verme/reddetme, site ayarından izni geri açıp devam etme.
2. Türkçe konuşma tanıma, sessizlik veya bağlantı kesilmesi sonrası kaldığı yerden devam.
3. Hatalı kelimede hızlı Tekrar/Atla, son kelimeyi bitirme ve yarıda durdurma.
   Ayrıca dinlerken/duraklamada/düzeltmede erken bitirme ve rapordan yeniden başlama.
4. Kelime seslendirmesinde Türkçe sesin bulunması, cihaz ses ayarı ve mobil izinler.
5. Kişisel veri içermeyen gerçek DOCX ve seçilebilir metinli PDF'nin canlı API'den
   metne dönüşmesi; taranmış/şifreli PDF yanıtları ve ilgili origin için CORS.

SpeechRecognition desteği ve hizmetin erişilebilirliği tarayıcıya göre değişebilir.
Destek bulunmadığında metin görüntülenebilir; sesli okuma düğmesi açıklamayla kapatılır.

## Kaynak incelemesinde doğrulanan eski sorunlar

İncelenen `main` commit'i: `af086bd4bd0cdf588d697b70d239e29b771d2e8a`.

- `isReading` yalnızca `onstart` içinde değişiyordu: hızlı çift tıklama `start()`
  çakışması oluşturuyordu; düzeltme sırasında eski `onend` beklenmiyordu.
- `onend` koşulsuz rapor açıyor, son doğru kelime mikrofonu durdurmuyordu.
- Hatalar `incorrectWordsList.includes(kelime)` ve `pop()` ile tutuluyordu:
  yinelenen konumlar eksik sayılıyor, yanlış konumun kaydı silinebiliyordu.
- Sadece son tanıma sonucu işleniyor ve noktalama yalnızca belge tarafından
  temizleniyordu. Bunlar sahte olaylarla yeniden üretildi.
- Metin ve dosya adı `innerHTML` içine yerleştiriliyordu; boyut/uzantı/yanıt denetimi,
  gerçek sürükle-bırak, destek açıklaması ve klavye odağı yönetimi eksikti.

## Backend uyumluluğu ve CORS

Backend'in [`88c0fd4` sürümü](https://github.com/yilmazsayin/okumadunyasiBE/blob/88c0fd4598f3c1e51befa4529fb71eb23b31ff13/app.py)
yalnızca okunarak incelendi. PDF/DOCX imza ve boyut doğrulaması, kaynak sınırları,
güvenli JSON hata yanıtları ve origin sınırlaması backend'de bulunur. Bu frontend
görevinde backend dosyaları, Render veya Vercel ayarları değiştirilmemiştir.

Canlı origin `https://okumadunyasi.vercel.app` izinlidir. Backend kaynak kodu ayrıca
`localhost` / `127.0.0.1` için `3000` ve `5173` portlarını kabul eder. Vercel preview
adresleri farklı origin'dir ve otomatik izinli değildir. Preview isteği CORS nedeniyle
engellenirse bu frontend hatası olarak değerlendirilmemeli; gereken **tam preview
origin'i** ayrıca yetkilendirilmelidir. Güvenlik kontrolleri veya CORS gevşetilmez.
Bu görevde canlı preview origin'i ve Render çalışma zamanı CORS ayarları doğrulanmadı.
