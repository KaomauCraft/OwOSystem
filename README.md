# OwO Teslimat Merkezi (OTM)

Discord.js tabanlı OTM botu.

## Kurulum
1. Node.js 22 veya üzerini kullanın.
2. `npm install` çalıştırın.
3. `.env.example` dosyasını `.env` olarak kopyalayıp `DISCORD_TOKEN` alanını doldurun.
4. Botu sunucuya `Manage Channels`, `View Channels`, `Send Messages`, `Read Message History` ve `Use Application Commands` izinleriyle ekleyin.
5. `npm start` ile çalıştırın.

Botun sunucu, kanal ve rol ID'leri `src/config.js` içindedir. Stok kodları `data/codes.json` dosyasında tutulur. Bu dosyaya yalnızca gerçekten satılabilir ve henüz kullanılmamış kodlar eklenmelidir.

## İlk sürüm
- Destek paneli ve özel destek kanalları
- Teslimat paneli ve kod doğrulama
- Geçerli kodla özel teslimat bekleme kanalı
- Kodların tek kullanımlık olması
- Panel mesajlarının yeniden başlatmalarda çoğaltılmaması

Bot, Discord kullanıcı hesaplarını otomatikleştirmez; yalnızca normal Discord bot API'sini kullanır.
