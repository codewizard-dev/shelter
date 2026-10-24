# Бункер 18+ — сервер

Сайт и игровой сервер в одной папке. Внешние пакеты не нужны, только **Node.js 18 или новее**.

```
bunker18-server/
├─ server.js        игровой сервер
├─ package.json
└─ public/index.html  сам сайт
```

## 1. Проверить у себя на компьютере

1. Установите Node.js с сайта nodejs.org (версия LTS).
2. Откройте терминал в папке `bunker18-server` и выполните:
   ```
   node server.js
   ```
3. Откройте в браузере http://localhost:3000

Чтобы поиграть с друзьями из той же Wi-Fi сети, дайте им адрес вида `http://192.168.x.x:3000` (IP вашего компьютера).

## 2. Выложить на VPS (Timeweb Cloud, Selectel, Beget и т. п.)

Подойдёт самый дешёвый сервер с Ubuntu 22.04 или 24.04.

**Подключитесь к серверу** (данные приходят на почту после покупки):
```
ssh root@IP_СЕРВЕРА
```

**Установите Node.js:**
```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

**Загрузите папку на сервер** (команда выполняется на вашем компьютере, не на сервере):
```
scp -r bunker18-server root@IP_СЕРВЕРА:/opt/
```

**Запустите как службу, чтобы сервер работал после перезагрузки:**
```
cat > /etc/systemd/system/bunker.service <<'EOF'
[Unit]
Description=Bunker 18+
After=network.target

[Service]
WorkingDirectory=/opt/bunker18-server
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now bunker
```

Сайт уже работает по адресу `http://IP_СЕРВЕРА:3000`.

## 3. Свой домен и HTTPS (по желанию)

1. Купите домен и в его настройках DNS создайте запись **A** с IP сервера.
2. Установите nginx и сертификат:
   ```
   apt install -y nginx certbot python3-certbot-nginx
   ```
3. Создайте файл `/etc/nginx/sites-available/bunker` (замените `bunker18.ru` на свой домен):
   ```
   server {
     server_name bunker18.ru;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_buffering off;
       proxy_read_timeout 1h;
     }
   }
   ```
   Строки `proxy_buffering off` и `proxy_read_timeout` обязательны: без них игроки не будут видеть ходы друг друга.
4. Включите сайт и получите HTTPS:
   ```
   ln -s /etc/nginx/sites-available/bunker /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d bunker18.ru
   ```

## 4. Вариант без VPS: Render.com

1. Загрузите папку в репозиторий на GitHub.
2. На render.com создайте **Web Service** из этого репозитория.
3. Build Command оставьте пустым, Start Command: `node server.js`.

На бесплатном тарифе сервер засыпает без игроков, и первое открытие сайта занимает до минуты. Кроме того, при перезапуске теряются активные комнаты.

## Как это работает

* Комнаты, игроки и карты хранятся в памяти сервера и каждые 10 секунд сохраняются в `data.json`.
* Комнаты старше 12 часов удаляются автоматически.
* Карты каждого игрока видит только он сам.
* Карты открываются по очереди, голосование открытое. Партией управляет ведущий (создатель комнаты). Если он закроет вкладку, остальные увидят застывший таймер: ведущему нужно вернуться на сайт с того же браузера, и игра продолжится.

Обновить сайт: замените `public/index.html` и выполните `systemctl restart bunker`.
