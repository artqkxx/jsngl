const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

// Load private local settings without a dependency. Host environment variables take precedence.
const LOCAL_ENV_PATH = path.join(__dirname, '.env.local');
if (fs.existsSync(LOCAL_ENV_PATH)) {
  for (const line of fs.readFileSync(LOCAL_ENV_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

const app = express();

const PORT = process.env.PORT || 5000;

const JWT_SECRET =
  process.env.JWT_SECRET || 'supersecret_upgrader_key';
const GOOGLE_CLIENT_ID = String(
  process.env.GOOGLE_CLIENT_ID || '116286195915-i6mh65ngnoj953jh3k6dbhmallftd8oq.apps.googleusercontent.com'
).trim();
const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);

const DB_PATH = path.join(__dirname, 'db.json');
const AVATAR_UPLOAD_DIR = process.env.AVATAR_UPLOAD_DIR || path.join(__dirname, 'uploads', 'avatars');
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const GOOGLE_AVATAR_HOST = /^lh\d+\.googleusercontent\.com$/i;

async function cacheGoogleAvatar(userId, pictureUrl) {
  try {
    let url = new URL(String(pictureUrl || ''));
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== 'https:' || !GOOGLE_AVATAR_HOST.test(url.hostname)) return null;

      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) return null;
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body || !String(response.headers.get('content-type') || '').toLowerCase().startsWith('image/')) return null;

      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_AVATAR_BYTES) return null;
        chunks.push(buffer);
      }
      const imageBuffer = Buffer.concat(chunks);
      const isPng = imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isJpeg = imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff;
      const isWebp = imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP';
      if (!isPng && !isJpeg && !isWebp) return null;

      const extension = isPng ? 'png' : isJpeg ? 'jpg' : 'webp';
      const filename = `${userId}-${require('crypto').randomBytes(8).toString('hex')}.${extension}`;
      fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(AVATAR_UPLOAD_DIR, filename), imageBuffer, { flag: 'wx' });
      return `/uploads/avatars/${filename}`;
    }
  } catch (error) {
    console.warn('Не удалось сохранить Google-аватар:', error.message);
  }
  return null;
}

// ======================================================
// TELEGRAM BOT
// ======================================================

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_WITHDRAWAL_CHAT_ID = String(process.env.TELEGRAM_WITHDRAWAL_CHAT_ID || '').trim();
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const TELEGRAM_POLLING = /^(1|true|yes)$/i.test(String(process.env.TELEGRAM_POLLING || ''));
const WITHDRAWAL_ADMIN_USERNAME = String(process.env.WITHDRAWAL_ADMIN_USERNAME || 'sogrsupport')
  .trim().replace(/^@/, '').toLowerCase();
const MAX_WITHDRAWAL_IMAGE_BYTES = 1.5 * 1024 * 1024;

const STARS_TO_GOLD_RATE = 1;

async function telegramApi(method, payload, timeoutMs = 15000) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

async function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    console.error('Telegram polling не запущен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET.');
    return;
  }
  try {
    await telegramApi('deleteWebhook', { drop_pending_updates: false });
    console.log('Telegram polling включён; входящие события будут обрабатываться локальным сервером.');
  } catch (error) {
    console.error('Не удалось включить Telegram polling:', error.message);
    return;
  }

  let offset = Number(readDB().telegramUpdateOffset || 0);
  while (true) {
    try {
      const updates = await telegramApi('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query']
      }, 35000);
      for (const update of updates || []) {
        const relay = await fetch(`http://127.0.0.1:${PORT}/api/telegram/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_WEBHOOK_SECRET },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(30000)
        });
        if (!relay.ok) {
          console.error('Локальная обработка обновления Telegram завершилась ошибкой:', relay.status);
          continue;
        }
        offset = Number(update.update_id) + 1;
        const db = readDB();
        db.telegramUpdateOffset = offset;
        writeDB(db);
      }
    } catch (error) {
      console.error('Ошибка Telegram polling:', error.message);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
}

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(express.json({ limit: '6mb' }));

app.use('/uploads/avatars', express.static(AVATAR_UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(__dirname));

// ======================================================
// ГЛАВНАЯ СТРАНИЦА
// ======================================================

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// ======================================================
// JSON DATABASE
// ======================================================

function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(
        DB_PATH,
        JSON.stringify(
          { users: [] },
          null,
          2
        ),
        'utf8'
      );
    }

    const data =
      fs.readFileSync(
        DB_PATH,
        'utf8'
      );

    return JSON.parse(data);
  } catch (err) {
    console.error(
      'Ошибка чтения db.json:',
      err
    );

    return {
      users: []
    };
  }
}

function writeDB(data) {
  const tempPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(
      tempPath,
      JSON.stringify(
        data,
        null,
        2
      ),
      'utf8'
    );
    fs.renameSync(tempPath, DB_PATH);
    return true;
  } catch (err) {
    console.error(
      'Ошибка записи в db.json:',
      err
    );
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      console.error('Не удалось удалить временный файл базы:', cleanupError);
    }
    return false;
  }
}

function findUserById(id) {
  const db = readDB();

  return db.users.find(
    user => user.id === id
  );
}

function findUserByUsername(username) {
  const db = readDB();

  return db.users.find(
    user =>
      user.username === username
  );
}

function saveUser(user) {
  const db = readDB();

  const index =
    db.users.findIndex(
      u => u.id === user.id
    );

  if (index !== -1) {
    db.users[index] = user;
  } else {
    db.users.push(user);
  }

  return writeDB(db);
}

// ======================================================
// STORE SKINS
// ======================================================

const storeSkins = [

  {
    id: 'st_1',
    name: 'AKR Dragon',
    price: 352,
    rarity: 'arcane',
    image: '/img/AKR_dragon.png'
  },

  {
    id: 'st_2',
    name: 'Karambit Gold',
    price: 12000,
    rarity: 'nameless',
    image: '/img/karambit_gold.png'
  },

  {
    id: 'st_3',
    name: 'AKR Treasure',
    price: 7000,
    rarity: 'arcane',
    image: '/img/akr_treasure.png'
  },

  {
    id: 'st_4',
    name: 'AWM Sport',
    price: 2800,
    rarity: 'legendary',
    image: '/img/awm_sport.png'
  },

  {
    id: 'st_7',
    name: 'M9 Bayonet | Ancient',
    price: 7077,
    rarity: 'legendary',
    image: '/img/m9_bayonet_ancient.png'
  },

  {
    id: 'st_8',
    name: 'M9 Bayonet | Scratch',
    price: 19220,
    rarity: 'nameless',
    image: '/img/m9_bayonet_scratch.png'
  },

  {
    id: 'st_9',
    name: 'Butterfly | Legacy',
    price: 1800,
    rarity: 'nameless',
    image: '/img/butterfly_legacy.png'
  },

  {
    id: 'st_10',
    name: 'Butterfly | Black Widow',
    price: 1498,
    rarity: 'nameless',
    image: '/img/butterfly_black_widow.png'
  },

  {
    id: 'st_11',
    name: 'Tanto | Yakuza',
    price: 1330,
    rarity: 'arcane',
    image: '/img/tanto_yakuza.png'
  },

  {
    id: 'st_12',
    name: 'Karambit | Frozen',
    price: 3955,
    rarity: 'nameless',
    image: '/img/karambit_frozen.png'
  },

  {
    id: 'st_13',
    name: 'Karambit | Nebula',
    price: 3780,
    rarity: 'nameless',
    image: '/img/karambit_nebula.png'
  },

  {
    id: 'st_14',
    name: 'Gloves | Onyx',
    price: 1090,
    rarity: 'legendary',
    image: '/img/gloves_onyx.png'
  },

  {
    id: 'st_15',
    name: 'Gloves | Phoenix Risen',
    price: 1748,
    rarity: 'nameless',
    image: '/img/gloves_phoenix_risen.png'
  },

  {
    id: 'st_16',
    name: 'Gloves | Neuro',
    price: 6640,
    rarity: 'nameless',
    image: '/img/gloves_neuro.png'
  },

  {
    id: 'st_17',
    name: 'Gloves | Geometric',
    price: 5700,
    rarity: 'arcane',
    image: '/img/gloves_geometric.png'
  },

  {
    id: 'st_18',
    name: 'Gloves | Ice Storm',
    price: 1680,
    rarity: 'legendary',
    image: '/img/gloves_ice_storm.png'
  },

  {
    id: 'st_19',
    name: 'Gloves | Flicker',
    price: 640,
    rarity: 'epic',
    image: '/img/gloves_firm_grip.png'
  },

  {
    id: 'st_21',
    name: 'Gloves | Shatter',
    price: 1500,
    rarity: 'arcane',
    image: '/img/gloves_shatter.png'
  },

  {
    id: 'st_22',
    name: 'Gloves | Retro Wave',
    price: 3950,
    rarity: 'nameless',
    image: '/img/gloves_retro_wave.png'
  },

  {
    id: 'st_23',
    name: 'Kukri | Gold Trim',
    price: 600,
    rarity: 'legendary',
    image: '/img/kukri_gold_trim.png'
  }

];

storeSkins.push(...require('./skin-batch.json'));

// ======================================================
// ITEM HISTORY
// ======================================================

function ensureItemHistory(user) {
  user.itemHistory = Array.isArray(user.itemHistory)
    ? user.itemHistory
    : [];

  const seenIds = new Set(
    user.itemHistory
      .map(item => item && item.id)
      .filter(Boolean)
  );

  // Добавляем текущие предметы, если они были созданы до
  // появления отдельной истории предметов.
  const inventory = Array.isArray(user.inventory)
    ? user.inventory
    : [];

  inventory.forEach(item => {
    if (!item || !item.id || seenIds.has(item.id)) return;

    user.itemHistory.push({
      id: item.id,
      name: item.name || 'Скин',
      price: Number(item.price || 0),
      image: item.image || null,
      rarity: item.rarity || 'common',
      date: item.createdAt || new Date().toISOString(),
      source: 'inventory'
    });

    seenIds.add(item.id);
  });

  // Восстанавливаем историю предметов, которые уже были
  // потрачены в старых апгрейдах. targetItem здесь намеренно
  // НЕ используется: целевой предмет при проигрыше в инвентаре
  // никогда не находился.
  const upgrades = Array.isArray(user.upgradeHistory)
    ? user.upgradeHistory
    : [];

  upgrades.forEach(upgrade => {
    const date = upgrade && upgrade.date
      ? upgrade.date
      : new Date().toISOString();

    const inputs = Array.isArray(upgrade && upgrade.inputItems)
      ? upgrade.inputItems
      : [];

    inputs.forEach((item, index) => {
      if (!item || (!item.name && !item.image)) return;

      const id = item.id || `legacy_${upgrade.id || 'upg'}_${index}`;
      if (seenIds.has(id)) return;

      user.itemHistory.push({
        id,
        name: item.name || 'Скин',
        price: Number(item.price || 0),
        image: item.image || null,
        rarity: item.rarity || 'common',
        date,
        source: 'upgrade-input'
      });

      seenIds.add(id);
    });

    // Только выигранный targetItem реально попадает в инвентарь.
    if (upgrade && upgrade.result === 'win' && upgrade.targetItem) {
      const item = upgrade.targetItem;
      const id = item.id || `legacy_win_${upgrade.id || Date.now()}`;

      if (!seenIds.has(id) && (item.name || item.image)) {
        user.itemHistory.push({
          id,
          name: item.name || 'Скин',
          price: Number(item.price || 0),
          image: item.image || null,
          rarity: item.rarity || 'common',
          date,
          source: 'upgrade-win'
        });
        seenIds.add(id);
      }
    }
  });

  user.itemHistory.sort((a, b) =>
    new Date(b.date || 0) - new Date(a.date || 0)
  );

  user.itemHistory = user.itemHistory.slice(0, 200);
}

function addItemToHistory(user, item, source) {
  if (!item) return;

  ensureItemHistory(user);

  const id = item.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (user.itemHistory.some(historyItem => historyItem.id === id)) return;

  user.itemHistory.unshift({
    id,
    name: item.name || 'Скин',
    price: Number(item.price || 0),
    image: item.image || null,
    rarity: item.rarity || 'common',
    date: new Date().toISOString(),
    source: source || 'inventory'
  });

  user.itemHistory = user.itemHistory.slice(0, 200);
}

// ======================================================
// AUTH MIDDLEWARE
// ======================================================

function authenticateToken(
  req,
  res,
  next
) {

  const authHeader =
    req.headers['authorization'];

  const token =
    authHeader &&
    authHeader.split(' ')[1];

  if (!token) {

    return res.status(401).json({
      success: false,
      message: 'Нет авторизации'
    });
  }

  jwt.verify(
    token,
    JWT_SECRET,
    (err, userPayload) => {

      if (err) {

        return res.status(403).json({
          success: false,
          message:
            'Недействительный токен'
        });
      }

      const user =
        findUserById(
          userPayload.id
        );

      if (!user) {

        return res.status(404).json({
          success: false,
          message:
            'Пользователь не найден'
        });
      }

      user.paymentHistory =
        Array.isArray(
          user.paymentHistory
        )
          ? user.paymentHistory
          : [];

      user.upgradeHistory =
        Array.isArray(
          user.upgradeHistory
        )
          ? user.upgradeHistory
          : [];

      ensureItemHistory(user);

      user.upgradesCount =
        Number(
          user.upgradesCount || 0
        );

      req.user =
        user;

      next();
    }
  );
}

// ======================================================
// PROFILE AVATAR UPLOAD
// ======================================================

app.post('/api/user/avatar', authenticateToken, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) {
    return res.status(400).json({ success: false, message: 'Загрузите изображение PNG, JPG или WebP' });
  }

  const imageBuffer = Buffer.from(match[2], 'base64');
  if (!imageBuffer.length || imageBuffer.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ success: false, message: 'Аватар после обработки должен быть не больше 2 МБ' });
  }

  const mime = match[1];
  const isPng = mime === 'image/png' && imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = mime === 'image/jpeg' && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff;
  const isWebp = mime === 'image/webp' && imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) {
    return res.status(400).json({ success: false, message: 'Файл не распознан как поддерживаемое изображение' });
  }

  const extension = isPng ? 'png' : isJpeg ? 'jpg' : 'webp';
  const filename = `${req.user.id}-${require('crypto').randomBytes(8).toString('hex')}.${extension}`;
  const filePath = path.join(AVATAR_UPLOAD_DIR, filename);
  const previousAvatar = String(req.user.avatar || '');
  try {
    fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(filePath, imageBuffer, { flag: 'wx' });
  } catch (error) {
    console.error('Не удалось сохранить аватар:', error);
    return res.status(500).json({ success: false, message: 'Не удалось сохранить аватар на сервере' });
  }

  req.user.avatar = `/uploads/avatars/${filename}`;
  if (!saveUser(req.user)) {
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(500).json({ success: false, message: 'Не удалось обновить профиль' });
  }

  const previousFilename = path.basename(previousAvatar);
  if (new RegExp(`^${req.user.id}-[a-f0-9]{16}\\.(?:png|jpg|webp)$`).test(previousFilename) && previousFilename !== filename) {
    try { fs.unlinkSync(path.join(AVATAR_UPLOAD_DIR, previousFilename)); } catch {}
  }

  return res.json({ success: true, avatar: req.user.avatar });
});

function decodeWithdrawalImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > MAX_WITHDRAWAL_IMAGE_BYTES) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  return buffer;
}

app.post('/api/withdrawal/quote', authenticateToken, (req, res) => {
  const itemId = String(req.body?.itemId || '');
  const item = (Array.isArray(req.user.inventory) ? req.user.inventory : []).find(entry => entry && String(entry.id) === itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Предмет не найден в инвентаре' });
  const itemPrice = Number(item.price);
  if (!Number.isFinite(itemPrice) || itemPrice <= 0) return res.status(400).json({ success: false, message: 'У предмета некорректная цена' });
  const offsetCents = Math.floor(Math.random() * 21) - 10;
  const listingPrice = Math.max(1, Math.round(itemPrice * 1.2 * 100) + offsetCents) / 100;
  const quoteId = require('crypto').randomBytes(16).toString('hex');
  const quote = jwt.sign({ purpose: 'withdrawal', userId: req.user.id, itemId, itemPrice, listingPrice, quoteId }, JWT_SECRET, { expiresIn: '30m' });
  return res.json({ success: true, quote, quoteId, listingPrice, item: { id: item.id, name: item.name, image: item.image || null, price: itemPrice } });
});

app.post('/api/withdrawal/submit', authenticateToken, async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ success: false, message: 'Вывод временно недоступен: не настроен Telegram-бот' });
  const recipientChatId = TELEGRAM_WITHDRAWAL_CHAT_ID || String(readDB().withdrawalTelegramChatId || '');
  if (!recipientChatId) return res.status(503).json({ success: false, message: 'Не подключен чат получателя заявок. Администратору нужно открыть бота и отправить /start' });

  let quote;
  try {
    quote = jwt.verify(String(req.body?.quote || ''), JWT_SECRET);
  } catch {
    return res.status(400).json({ success: false, message: 'Срок заявки истёк. Начните оформление заново' });
  }
  if (quote.purpose !== 'withdrawal' || quote.userId !== req.user.id) return res.status(400).json({ success: false, message: 'Некорректная заявка на вывод' });
  const pattern = String(req.body?.pattern || '').trim();
  if (!pattern || pattern.length > 80) return res.status(400).json({ success: false, message: 'Укажите паттерн (до 80 символов)' });
  const marketImage = decodeWithdrawalImage(req.body?.marketScreenshot);
  const avatarImage = decodeWithdrawalImage(req.body?.avatar);
  if (!marketImage || !avatarImage) return res.status(400).json({ success: false, message: 'Добавьте скриншот рынка и аватар в формате WebP до 1,5 МБ каждый' });

  const db = readDB();
  const user = db.users.find(entry => entry.id === req.user.id);
  const requests = Array.isArray(db.withdrawalRequests) ? db.withdrawalRequests : [];
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  if (requests.some(request => request.quoteId === quote.quoteId)) return res.status(409).json({ success: false, message: 'Эта заявка уже отправлена' });
  const itemIndex = (Array.isArray(user.inventory) ? user.inventory : []).findIndex(item => item && String(item.id) === quote.itemId);
  if (itemIndex < 0) return res.status(409).json({ success: false, message: 'Предмет уже отсутствует в инвентаре' });
  const item = user.inventory[itemIndex];
  if (Math.abs(Number(item.price) - Number(quote.itemPrice)) > 0.0001) return res.status(409).json({ success: false, message: 'Цена предмета изменилась. Начните оформление заново' });

  const caption = [
    'ЗАЯВКА НА ВЫВОД СКИНА',
    `ID сайта: ${user.id}`,
    `Ник: ${String(user.username || '—').slice(0, 80)}`,
    `Предмет: ${String(item.name || 'Скин').slice(0, 120)}`,
    `Цена предмета: ${Number(item.price).toFixed(2)} G`,
    `Цена выставления: ${Number(quote.listingPrice).toFixed(2)} G`,
    `Паттерн: ${pattern}`,
    `Заявка: ${quote.quoteId}`,
    `Время: ${new Date().toISOString()}`
  ].join('\n');
  const form = new FormData();
  form.append('chat_id', recipientChatId);
  form.append('media', JSON.stringify([
    { type: 'photo', media: 'attach://market.webp', caption, parse_mode: undefined },
    { type: 'photo', media: 'attach://avatar.webp' }
  ]));
  form.append('market.webp', new Blob([marketImage], { type: 'image/webp' }), 'market.webp');
  form.append('avatar.webp', new Blob([avatarImage], { type: 'image/webp' }), 'avatar.webp');
  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const telegramResult = await telegramResponse.json();
    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error('Telegram withdrawal delivery failed:', telegramResult.description || telegramResponse.status);
      return res.status(502).json({ success: false, message: 'Не удалось отправить заявку. Попробуйте ещё раз позже' });
    }
  } catch (error) {
    console.error('Telegram withdrawal delivery failed:', error.message);
    return res.status(502).json({ success: false, message: 'Не удалось отправить заявку. Попробуйте ещё раз позже' });
  }

  let controlMessageId = null;
  try {
    const controlResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: recipientChatId,
        text: `УПРАВЛЕНИЕ ЗАЯВКОЙ ${quote.quoteId}\nID сайта: ${user.id}\nСкин: ${String(item.name || 'Скин').slice(0, 100)}\nСтатус: В процессе`,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Принять', callback_data: `withdrawal:done:${quote.quoteId}` },
          { text: '❌ Отклонить', callback_data: `withdrawal:reject:${quote.quoteId}` }
        ]] }
      }), signal: AbortSignal.timeout(15000)
    });
    const controlResult = await controlResponse.json();
    if (controlResponse.ok && controlResult.ok) controlMessageId = controlResult.result?.message_id || null;
    else console.error('Telegram withdrawal controls failed:', controlResult.description || controlResponse.status);
  } catch (error) {
    console.error('Telegram withdrawal controls failed:', error.message);
  }
  if (!controlMessageId) return res.status(502).json({ success: false, message: 'Фото заявки отправлены, но не удалось создать кнопки управления. Сообщите поддержке, ID заявки: ' + quote.quoteId });

  user.inventory.splice(itemIndex, 1);
  db.withdrawalRequests = [...requests, {
    quoteId: quote.quoteId,
    userId: user.id,
    itemId: item.id,
    itemName: String(item.name || 'Скин'),
    itemImage: item.image || null,
    itemPrice: Number(item.price),
    listingPrice: Number(quote.listingPrice),
    status: 'in_process',
    reason: '',
    telegramChatId: String(recipientChatId),
    telegramControlMessageId: controlMessageId,
    createdAt: new Date().toISOString()
  }].slice(-5000);
  const userIndex = db.users.findIndex(entry => entry.id === user.id);
  db.users[userIndex] = user;
  if (!writeDB(db)) return res.status(500).json({ success: false, message: 'Заявка отправлена, но не удалось обновить инвентарь. Свяжитесь с поддержкой' });
  return res.json({ success: true, updatedInventory: user.inventory });
});

app.get('/api/withdrawal/history', authenticateToken, (req, res) => {
  const db = readDB();
  const history = (Array.isArray(db.withdrawalRequests) ? db.withdrawalRequests : [])
    .filter(request => request && request.userId === req.user.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 100)
    .map(request => ({
      quoteId: request.quoteId,
      itemName: request.itemName || 'Скин',
      itemImage: request.itemImage || null,
      itemPrice: Number(request.itemPrice || 0),
      listingPrice: Number(request.listingPrice || 0),
      status: request.status === 'withdrawn' ? 'withdrawn' : request.status === 'rejected' ? 'rejected' : 'in_process',
      reason: String(request.reason || ''),
      createdAt: request.createdAt || null
    }));
  res.json({ success: true, history });
});

// ======================================================
// TELEGRAM STARS
// ======================================================

app.post(
  '/api/payment/create-stars-invoice',
  authenticateToken,
  async (req, res) => {

    try {

      const {
        amount
      } = req.body;

      const goldAmount =
        parseFloat(amount);

      if (
        isNaN(goldAmount) ||
        goldAmount <= 0
      ) {

        return res.json({
          success: false,
          message:
            'Укажите корректную сумму'
        });
      }

      if (
        !Number.isInteger(
          goldAmount
        )
      ) {

        return res.json({
          success: false,
          message:
            'Для оплаты Stars укажите целое количество G'
        });
      }

      const starsAmount =
        Math.ceil(
          goldAmount /
          STARS_TO_GOLD_RATE
        );

      const payload =
        JSON.stringify({

          userId:
            req.user.id,

          goldAmount:
            goldAmount,

          timestamp:
            Date.now()
        });

      const invoiceData = {

        title:
          'Пополнение баланса SOGRADER',

        description:
          `Зачисление ${goldAmount} G на аккаунт ${req.user.username}`,

        payload:
          payload,

        currency:
          'XTR',

        prices: [

          {
            label:
              `${goldAmount} Gold`,

            amount:
              starsAmount
          }

        ]
      };

      const response =
        await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createInvoiceLink`,
          {

            method:
              'POST',

            headers: {

              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify(
                invoiceData
              )
          }
        );

      const data =
        await response.json();

      if (data.ok) {

        return res.json({

          success:
            true,

          invoiceUrl:
            data.result
        });
      }

      console.error(
        'Ошибка Telegram API:',
        data
      );

      return res.json({

        success:
          false,

        message:
          'Не удалось создать счет для оплаты'
      });

    } catch (err) {

      console.error(
        'Ошибка сервера при создании счета:',
        err
      );

      return res.status(500).json({

        success:
          false,

        message:
          'Ошибка сервера'
      });
    }
  }
);

// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

app.post(
  '/api/telegram/webhook',
  async (req, res) => {

    try {

      const update =
        req.body;

      const webhookAuthenticated = Boolean(TELEGRAM_WEBHOOK_SECRET) &&
        req.get('X-Telegram-Bot-Api-Secret-Token') === TELEGRAM_WEBHOOK_SECRET;
      const currentDB = readDB();
      const adminChatId = TELEGRAM_WITHDRAWAL_CHAT_ID || String(currentDB.withdrawalTelegramChatId || '');

      if (update.callback_query) {
        if (!webhookAuthenticated) return res.sendStatus(401);
        const callback = update.callback_query;
        const callbackChatId = String(callback.message?.chat?.id || '');
        if (!adminChatId || callbackChatId !== String(adminChatId)) {
          try { await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Нет доступа' }); } catch {}
          return res.sendStatus(200);
        }
        const match = String(callback.data || '').match(/^withdrawal:(done|reject):([a-f0-9]{32})$/i);
        if (!match) {
          try { await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Неизвестное действие' }); } catch {}
          return res.sendStatus(200);
        }
        const [, action, quoteId] = match;
        const db = readDB();
        const requests = Array.isArray(db.withdrawalRequests) ? db.withdrawalRequests : [];
        const request = requests.find(entry => entry.quoteId === quoteId && String(entry.telegramChatId) === callbackChatId);
        if (!request) {
          try { await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Заявка не найдена' }); } catch {}
          return res.sendStatus(200);
        }
        if (request.status !== 'in_process') {
          try { await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Заявка уже обработана' }); } catch {}
          return res.sendStatus(200);
        }

        if (action.toLowerCase() === 'reject') {
          try {
            await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Отправьте причину ответом на сообщение бота' });
            const prompt = await telegramApi('sendMessage', {
              chat_id: callbackChatId,
              text: `Укажите причину отклонения заявки ${quoteId} ответом на это сообщение.`,
              reply_to_message_id: callback.message.message_id,
              reply_markup: { force_reply: true, selective: true }
            });
            const promptKey = `${callbackChatId}:${prompt.message_id}`;
            db.pendingWithdrawalRejections = { ...(db.pendingWithdrawalRejections || {}), [promptKey]: { quoteId, controlMessageId: callback.message.message_id } };
            if (!writeDB(db)) console.error('Не удалось сохранить запрос причины отклонения:', quoteId);
          } catch (error) {
            console.error('Не удалось запросить причину отклонения:', error.message);
          }
          return res.sendStatus(200);
        }

        request.status = 'withdrawn';
        request.updatedAt = new Date().toISOString();
        if (!writeDB(db)) {
          try { await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Не удалось сохранить статус' }); } catch {}
          return res.sendStatus(500);
        }
        try {
          await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Заявка отмечена как выведенная' });
          await telegramApi('editMessageText', {
            chat_id: callbackChatId,
            message_id: callback.message.message_id,
            text: `ЗАЯВКА ВЫВЕДЕНА ✓\nID заявки: ${quoteId}\nПользователь: ${request.userId}\nСкин: ${String(request.itemName || 'Скин').slice(0, 100)}`,
            reply_markup: { inline_keyboard: [] }
          });
        } catch (error) { console.error('Не удалось обновить сообщение о заявке:', error.message); }
        return res.sendStatus(200);
      }

      const incomingMessage = update.message;
      if (incomingMessage?.reply_to_message?.message_id && webhookAuthenticated && String(incomingMessage.chat?.id || '') === String(adminChatId)) {
        const db = readDB();
        const promptKey = `${incomingMessage.chat.id}:${incomingMessage.reply_to_message.message_id}`;
        const pending = db.pendingWithdrawalRejections?.[promptKey];
        if (pending) {
          const reason = String(incomingMessage.text || '').trim().slice(0, 500);
          const request = (Array.isArray(db.withdrawalRequests) ? db.withdrawalRequests : []).find(entry => entry.quoteId === pending.quoteId && String(entry.telegramChatId) === String(adminChatId));
          if (request && request.status === 'in_process' && reason) {
            request.status = 'rejected';
            request.reason = reason;
            request.updatedAt = new Date().toISOString();
            delete db.pendingWithdrawalRejections[promptKey];
            if (writeDB(db)) {
              try {
                await telegramApi('editMessageText', {
                  chat_id: String(adminChatId),
                  message_id: pending.controlMessageId,
                  text: `ЗАЯВКА ОТКЛОНЕНА ✕\nID заявки: ${request.quoteId}\nПользователь: ${request.userId}\nСкин: ${String(request.itemName || 'Скин').slice(0, 100)}\nПричина: ${reason}`,
                  reply_markup: { inline_keyboard: [] }
                });
              } catch (error) { console.error('Не удалось обновить сообщение отклонённой заявки:', error.message); }
            }
          } else if (!reason) {
            try { await telegramApi('sendMessage', { chat_id: String(adminChatId), text: 'Причина не может быть пустой. Ответьте на запрос причины ещё раз.' }); } catch {}
          }
          return res.sendStatus(200);
        }
      }

      const startMessage = update?.message;
      if (
        startMessage?.chat?.type === 'private' &&
        String(startMessage.from?.username || '').toLowerCase() === WITHDRAWAL_ADMIN_USERNAME &&
        /^\/start(?:@\w+)?(?:\s|$)/i.test(String(startMessage.text || ''))
      ) {
        const secretMatches = TELEGRAM_WEBHOOK_SECRET &&
          req.get('X-Telegram-Bot-Api-Secret-Token') === TELEGRAM_WEBHOOK_SECRET;
        if (secretMatches) {
          const db = readDB();
          db.withdrawalTelegramChatId = String(startMessage.chat.id);
          if (writeDB(db) && TELEGRAM_BOT_TOKEN) {
            fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: startMessage.chat.id, text: 'Чат подключен: сюда будут приходить заявки на вывод.' })
            }).catch(error => console.error('Не удалось подтвердить чат заявок:', error.message));
          }
        }
      }

      // --------------------------------------------------
      // PRE CHECKOUT
      // --------------------------------------------------

      if (
        update.pre_checkout_query
      ) {

        const queryId =
          update
            .pre_checkout_query
            .id;

        fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`,
          {

            method:
              'POST',

            headers: {

              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({

                pre_checkout_query_id:
                  queryId,

                ok:
                  true
              })
          }
        )
          .catch(
            err =>
              console.error(
                'Ошибка pre_checkout:',
                err
              )
          );

        return res.sendStatus(200);
      }

      // --------------------------------------------------
      // SUCCESSFUL PAYMENT
      // --------------------------------------------------

      if (
        update.message &&
        update.message.successful_payment
      ) {

        const payment =
          update.message
            .successful_payment;

        let payload;

        try {

          payload =
            JSON.parse(
              payment.invoice_payload
            );

        } catch (e) {

          console.error(
            'Некорректный payment payload:',
            payment.invoice_payload
          );

          return res.sendStatus(200);
        }

        const user =
          findUserById(
            payload.userId
          );

        if (user) {

          user.paymentHistory =
            Array.isArray(
              user.paymentHistory
            )
              ? user.paymentHistory
              : [];

          const chargeId =
            payment.telegram_payment_charge_id ||
            null;

          if (
            chargeId &&
            user.paymentHistory.some(
              item =>
                item.telegramPaymentChargeId ===
                chargeId
            )
          ) {

            return res.sendStatus(200);
          }

          const goldAmount =
            Number(
              payload.goldAmount ||
              0
            );

          user.balance =
            Number(
              user.balance ||
              0
            ) +
            goldAmount;

          user.paymentHistory.unshift({

            id:
              'pay_' +
              Date.now() +
              '_' +
              Math.random()
                .toString(36)
                .slice(2, 7),

            goldAmount:
              goldAmount,

            starsAmount:
              Number(
                payment.total_amount ||
                0
              ),

            telegramPaymentChargeId:
              chargeId,

            date:
              new Date()
                .toISOString()
          });

          user.paymentHistory =
            user.paymentHistory.slice(
              0,
              50
            );

          saveUser(
            user
          );

          console.log(
            `[STARS PAYMENT] Пользователь ${user.username} (ID: ${user.id}) успешно пополнил баланс на ${goldAmount} G!`
          );
        }
      }

      res.sendStatus(200);

    } catch (err) {

      console.error(
        'Ошибка вебхука Telegram:',
        err
      );

      res.sendStatus(500);
    }
  }
);

// ======================================================
// REGISTRATION
// ======================================================

app.post(
  '/api/auth/register',
  async (req, res) => {

    const {
      username,
      password
    } = req.body;

    if (
      !username ||
      !password
    ) {

      return res.json({

        success:
          false,

        message:
          'Заполните все поля'
      });
    }

    if (
      typeof username !== 'string' ||
      !/^[A-Za-z0-9]{3,12}$/.test(username) ||
      !/[a-z]/.test(username)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Никнейм должен содержать 3–12 латинских букв или цифр, включая минимум одну строчную букву'
      });
    }

    if (
      findUserByUsername(
        username
      )
    ) {

      return res.json({

        success:
          false,

        message:
          'Имя уже занято'
      });
    }

    const hashedPassword =
      await bcrypt.hash(
        password,
        10
      );

    const newUser = {

      id:
        Math.floor(
          100000 +
          Math.random() *
          900000
        ),

      username:
        username,

      password:
        hashedPassword,

      balance:
        0,

      inventory:
        [],

      itemHistory:
        [],

      upgradesCount:
        0,

      bestDrop:
        null,

      paymentHistory:
        [],

      upgradeHistory:
        []
    };

    saveUser(
      newUser
    );

    const token =
      jwt.sign(
        {

          id:
            newUser.id,

          username:
            newUser.username

        },

        JWT_SECRET
      );

    res.json({

      success:
        true,

      token:
        token,

      user:
        newUser
    });
  }
);

// ======================================================
// LOGIN
// ======================================================

app.get('/api/auth/google/config', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID || null });
});

app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ success: false, message: 'Вход через Google пока не настроен на сервере' });
  }

  const credential = String(req.body?.credential || '');
  if (!credential || credential.length > 16384) {
    return res.status(400).json({ success: false, message: 'Не удалось получить подтверждение от Google' });
  }

  let profile;
  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    profile = ticket.getPayload();
  } catch (error) {
    console.warn('Не удалось проверить Google ID token:', error.message);
    return res.status(401).json({ success: false, message: 'Не удалось подтвердить аккаунт Google' });
  }

  if (!profile?.sub || profile.email_verified !== true) {
    return res.status(401).json({ success: false, message: 'Google не подтвердил этот аккаунт' });
  }

  const db = readDB();
  let user = db.users.find(entry => entry.googleSub === profile.sub);
  let isNewUser = false;

  if (!user) {
    const fullName = String(
      profile.given_name && profile.family_name
        ? `${profile.given_name} ${profile.family_name}`
        : profile.name || profile.given_name || String(profile.email || '').split('@')[0] || 'Google игрок'
    ).trim();
    const googleNickname = Array.from(fullName).slice(0, 16).join('') || 'Google игрок';
    const requestedUsername = String(req.body?.username || '').trim();
    const username = requestedUsername || googleNickname;
    const usernameIsValid = Array.from(username).length <= 16
      && /^[\p{L}\p{N} ._'’-]+$/u.test(username)
      && username.trim().length > 0;

    if (!usernameIsValid) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_USERNAME',
        message: 'Ник может содержать до 16 букв, цифр, пробелов, точек, дефисов и подчёркиваний'
      });
    }

    const usernameTaken = db.users.some(
      entry => String(entry.username || '').trim().toLowerCase() === username.toLowerCase()
    );
    if (usernameTaken) {
      return res.status(409).json({
        success: false,
        code: 'USERNAME_TAKEN',
        message: 'Этот ник уже занят. Выберите другой.',
        suggestedUsername: googleNickname
      });
    }

    let id = Math.floor(100000 + Math.random() * 900000);
    while (db.users.some(entry => String(entry.id) === String(id))) {
      id = Math.floor(100000 + Math.random() * 900000);
    }

    const avatar = await cacheGoogleAvatar(id, profile.picture);

    user = {
      id,
      username,
      password: null,
      googleSub: profile.sub,
      googlePicture: profile.picture || null,
      email: profile.email || null,
      avatar,
      balance: 0,
      inventory: [],
      itemHistory: [],
      upgradesCount: 0,
      bestDrop: null,
      paymentHistory: [],
      upgradeHistory: []
    };

    db.users.push(user);
    if (!writeDB(db)) {
      if (avatar) {
        try { fs.unlinkSync(path.join(AVATAR_UPLOAD_DIR, path.basename(avatar))); } catch {}
      }
      return res.status(500).json({ success: false, message: 'Не удалось создать аккаунт' });
    }
    isNewUser = true;
  }

  if (!user.googlePicture && profile.picture) {
    user.googlePicture = profile.picture;
    if (!saveUser(user)) user.googlePicture = null;
  }
  const hasRemoteGoogleAvatar = /^https:\/\/lh\d+\.googleusercontent\.com\//i.test(String(user.avatar || ''));
  if (!isNewUser && (!user.avatar || hasRemoteGoogleAvatar)) {
    const previousAvatar = user.avatar;
    const cachedAvatar = await cacheGoogleAvatar(user.id, profile.picture || previousAvatar);
    if (cachedAvatar) {
      user.avatar = cachedAvatar;
      if (!saveUser(user)) {
        user.avatar = previousAvatar;
        try { fs.unlinkSync(path.join(AVATAR_UPLOAD_DIR, path.basename(cachedAvatar))); } catch {}
      }
    }
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  const { password, ...safeUser } = user;
  return res.json({ success: true, token, user: safeUser, isNewUser });
});

app.post(
  '/api/auth/login',
  async (req, res) => {

    const {
      username,
      password
    } = req.body;

    const user =
      findUserByUsername(
        username
      );

    if (!user || !user.password) {

      return res.json({

        success:
          false,

        message:
          'Неверные данные'
      });
    }

    const validPassword =
      await bcrypt.compare(
        password,
        user.password
      );

    if (!validPassword) {

      return res.json({

        success:
          false,

        message:
          'Неверные данные'
      });
    }

    const token =
      jwt.sign(
        {

          id:
            user.id,

          username:
            user.username

        },

        JWT_SECRET
      );

    res.json({

      success:
        true,

      token:
        token,

      user:
        user
    });
  }
);

// ======================================================
// CURRENT USER
// ======================================================

app.get(
  '/api/auth/me',
  authenticateToken,
  async (req, res) => {

    const user = req.user;
    const avatarPath = String(user.avatar || '');
    const remoteGoogleAvatar = /^https:\/\/lh\d+\.googleusercontent\.com\//i.test(avatarPath);
    const ownedAvatarFilename = path.basename(avatarPath);
    const ownedAvatarPath = /^\/uploads\/avatars\/[0-9]+-[a-f0-9]{16}\.(?:png|jpg|webp)$/i.test(avatarPath)
      ? path.join(AVATAR_UPLOAD_DIR, ownedAvatarFilename)
      : null;
    const missingLocalAvatar = Boolean(user.googleSub && ownedAvatarPath && !fs.existsSync(ownedAvatarPath));

    if (user.googleSub && (remoteGoogleAvatar || missingLocalAvatar || (!user.avatar && user.googlePicture))) {
      const previousAvatar = user.avatar;
      const cachedAvatar = await cacheGoogleAvatar(user.id, remoteGoogleAvatar ? user.avatar : user.googlePicture);
      if (cachedAvatar) {
        user.avatar = cachedAvatar;
        if (!saveUser(user)) {
          user.avatar = previousAvatar;
          try { fs.unlinkSync(path.join(AVATAR_UPLOAD_DIR, path.basename(cachedAvatar))); } catch {}
        }
      }
    }

    res.json({

      success:
        true,

      user:
        user
    });
  }
);

// ======================================================
// BUY SKIN
// ======================================================

app.post(
  '/api/shop/buy',
  authenticateToken,
  (req, res) => {

    const {
      skinId,
      count = 1
    } = req.body;

    const quantity =
      parseInt(
        count,
        10
      );

    if (
      isNaN(quantity) ||
      quantity <= 0
    ) {

      return res.json({

        success:
          false,

        message:
          'Некорректное количество'
      });
    }

    const skin =
      storeSkins.find(
        s =>
          s.id ===
          skinId
      );

    if (!skin) {

      return res.json({

        success:
          false,

        message:
          'Скин не найден'
      });
    }

    const totalPrice =
      skin.price *
      quantity;

    if (
      req.user.balance <
      totalPrice
    ) {

      return res.json({

        success:
          false,

        message:
          'Недостаточно средств'
      });
    }

    req.user.balance -=
      totalPrice;

    for (
      let i = 0;
      i < quantity;
      i++
    ) {

      const newInventoryItem = {

        ...skin,

        id:
          'inv_' +
          Date.now() +
          '_' +
          Math.random()
            .toString(36)
            .substr(2, 6)
      };

      req.user.inventory.push(
        newInventoryItem
      );

      addItemToHistory(
        req.user,
        newInventoryItem,
        'purchase'
      );
    }

    saveUser(
      req.user
    );

    res.json({

      success:
        true,

      user:
        req.user
    });
  }
);

// ======================================================
// SELL INVENTORY ITEM
// ======================================================

app.post(
  '/api/inventory/sell',
  authenticateToken,
  (req, res) => {

    const { itemId } = req.body || {};

    if (!itemId) {
      return res.json({
        success: false,
        message: 'Предмет не указан'
      });
    }

    const inventory = Array.isArray(req.user.inventory)
      ? req.user.inventory
      : [];

    const itemIndex = inventory.findIndex(
      item => item && item.id === itemId
    );

    if (itemIndex === -1) {
      return res.json({
        success: false,
        message: 'Предмет не найден в инвентаре'
      });
    }

    const item = inventory[itemIndex];
    const soldPrice = Number(item.price || 0);

    if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
      return res.json({
        success: false,
        message: 'У предмета некорректная цена'
      });
    }

    // Удаляем только конкретный экземпляр предмета.
    req.user.inventory.splice(itemIndex, 1);
    req.user.balance = Number(req.user.balance || 0) + soldPrice;

    saveUser(req.user);

    return res.json({
      success: true,
      soldPrice,
      newBalance: req.user.balance,
      updatedInventory: req.user.inventory
    });
  }
);

// ======================================================
// PROMOCODES
// ======================================================

app.post('/api/user/promo', authenticateToken, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    return res.status(400).json({ success: false, message: 'Некорректный промокод' });
  }

  const db = readDB();
  const promo = db.promoCodes?.[code];
  if (!promo) {
    return res.status(404).json({ success: false, message: 'Промокод не найден' });
  }
  if (promo.used) {
    return res.status(409).json({ success: false, message: 'Этот промокод уже использован' });
  }

  const reward = Number(promo.reward);
  if (!Number.isFinite(reward) || reward <= 0) {
    return res.status(400).json({ success: false, message: 'У промокода некорректная награда' });
  }

  const userIndex = db.users.findIndex(user => user.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  }

  req.user.balance = Math.round((Number(req.user.balance || 0) + reward) * 100) / 100;
  promo.used = true;
  promo.usedBy = req.user.id;
  promo.usedAt = new Date().toISOString();
  db.users[userIndex] = req.user;

  if (!writeDB(db)) {
    return res.status(500).json({ success: false, message: 'Не удалось сохранить промокод' });
  }
  return res.json({ success: true, code, added: reward, newBalance: req.user.balance });
});

app.post('/api/admin/promos', authenticateToken, (req, res) => {
  if (String(req.user.username || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ success: false, message: 'Недостаточно прав' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  const reward = Math.round(Number(req.body?.reward) * 100) / 100;
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    return res.status(400).json({ success: false, message: 'Код должен содержать 3–32 символа: латинские буквы, цифры, дефис или подчёркивание' });
  }
  if (!Number.isFinite(reward) || reward <= 0 || reward > 1000000) {
    return res.status(400).json({ success: false, message: 'Награда должна быть от 0.01 до 1 000 000 G' });
  }

  const db = readDB();
  db.promoCodes = db.promoCodes || {};
  if (db.promoCodes[code]) {
    return res.status(409).json({ success: false, message: 'Такой промокод уже существует' });
  }
  db.promoCodes[code] = {
    reward,
    used: false,
    usedBy: null,
    usedAt: null,
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };

  if (!writeDB(db)) {
    return res.status(500).json({ success: false, message: 'Не удалось сохранить промокод' });
  }
  return res.json({ success: true, code, reward });
});

// ======================================================
// UPGRADE
// ======================================================

app.post(
  '/api/upgrade',
  authenticateToken,
  (req, res) => {

    const {
      selectedItemIds,
      targetItem,
      addedBalance = 0
    } = req.body;

    if (
      !selectedItemIds ||
      !selectedItemIds.length ||
      !targetItem
    ) {

      return res.json({

        success:
          false,

        message:
          'Некорректные данные'
      });
    }

    if (selectedItemIds.length > 5) {
      return res.json({
        success: false,
        message: 'В один апгрейд можно добавить не более 5 предметов'
      });
    }

    const selectedSkins =
      req.user.inventory.filter(
        item =>
          selectedItemIds.includes(
            item.id
          )
      );

    if (
      selectedSkins.length !==
      selectedItemIds.length
    ) {

      return res.json({

        success:
          false,

        message:
          'Предметы не найдены в инвентаре'
      });
    }

    const totalInputSum =
      selectedSkins.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.price,

        0
      );

    const parsedAddedBalance = Number(addedBalance);
    const safeAddedBalance = Number.isFinite(parsedAddedBalance)
      ? Math.round(parsedAddedBalance * 100) / 100
      : NaN;
    const userBalance = Number(req.user.balance || 0);

    if (!Number.isFinite(safeAddedBalance) || safeAddedBalance < 0 || safeAddedBalance > userBalance) {
      return res.json({ success: false, message: 'Недостаточно баланса для этой ставки' });
    }

    const targetPrice = Number(targetItem.price);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return res.json({ success: false, message: 'Некорректная цена целевого предмета' });
    }

    const chance = ((totalInputSum + safeAddedBalance) / targetPrice) * 100;

    if (
      chance > 80.000001
    ) {

      return res.json({

        success:
          false,

        message:
          'Шанс превышает допустимые 80%'
      });
    }

    const cappedChance = Math.min(chance, 80);

    req.user.balance = Math.round((userBalance - safeAddedBalance) * 100) / 100;

    // Эти предметы действительно находились в инвентаре,
    // поэтому сохраняем их в истории даже после сгорания.
    selectedSkins.forEach(item => {
      addItemToHistory(
        req.user,
        item,
        'upgrade-input'
      );
    });

    req.user.inventory =
      req.user.inventory.filter(
        item =>
          !selectedItemIds.includes(
            item.id
          )
      );

    req.user.upgradesCount =
      (
        req.user.upgradesCount ||
        0
      ) + 1;

    const rolled =
      Math.random() *
      100;

    const isWin =
      rolled < cappedChance;

    if (isWin) {

      const newItem = {

        ...targetItem,

        id:
          'inv_' +
          Date.now() +
          '_' +
          Math.random()
            .toString(36)
            .substr(2, 4)
      };

      req.user.inventory.push(
        newItem
      );

      addItemToHistory(
        req.user,
        newItem,
        'upgrade-win'
      );

      if (
        !req.user.bestDrop ||
        newItem.price >
          req.user.bestDrop.price
      ) {

        req.user.bestDrop =
          newItem;
      }
    }

    req.user.upgradeHistory =
      Array.isArray(
        req.user.upgradeHistory
      )
        ? req.user.upgradeHistory
        : [];

    req.user.upgradeHistory.unshift({

      id:
        'upg_' +
        Date.now() +
        '_' +
        Math.random()
          .toString(36)
          .slice(2, 7),

      date:
        new Date()
          .toISOString(),

      chance:
        Number(
          cappedChance
        ),

      balanceStake:
        safeAddedBalance,

      rolled:
        Number(
          rolled
        ),

      result:
        isWin
          ? 'win'
          : 'loss',

      inputItems:
        selectedSkins.map(
          item => ({

            name:
              item.name,

            price:
              Number(
                item.price ||
                0
              ),

            image:
              item.image ||
              null
          })
        ),

      targetItem: {

        name:
          targetItem.name,

        price:
          Number(
            targetItem.price ||
            0
          ),

        image:
          targetItem.image ||
          null
      }
    });

    req.user.upgradeHistory =
      req.user.upgradeHistory.slice(
        0,
        50
      );

    if (!saveUser(req.user)) {
      return res.status(500).json({
        success: false,
        message: 'Не удалось сохранить апгрейд и списать баланс. Попробуйте ещё раз.'
      });
    }

    res.json({

      success:
        true,

      isWin:
        isWin,

      rolled:
        rolled,

      updatedInventory:
        req.user.inventory,

      newBalance:
        req.user.balance,

      chance:
        cappedChance,

      bestDrop:
        req.user.bestDrop,

      upgradesCount:
        req.user.upgradesCount,

      upgradeHistory:
        req.user.upgradeHistory,

      itemHistory:
        req.user.itemHistory
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Сервер успешно запущен на порту ${PORT}`
    );

    if (TELEGRAM_POLLING) {
      startTelegramPolling().catch(error => console.error('Telegram polling остановлен:', error.message));
    }

  }
);
