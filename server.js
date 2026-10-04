const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 5000;

const JWT_SECRET =
  process.env.JWT_SECRET || 'supersecret_upgrader_key';

const DB_PATH = path.join(__dirname, 'db.json');

// ======================================================
// TELEGRAM BOT
// ======================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  '8900159068:AAEUHEDg_Bbya7Xl-XN8voPXpXrpf822A4c';

const STARS_TO_GOLD_RATE = 1;

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(express.json());

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
  try {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify(
        data,
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    console.error(
      'Ошибка записи в db.json:',
      err
    );
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

  writeDB(db);
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
  (req, res) => {

    try {

      const update =
        req.body;

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
        2,

      inventory:
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

    if (!user) {

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
  (req, res) => {

    res.json({

      success:
        true,

      user:
        req.user
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
// PROMOCODE
// ======================================================

app.post(
  '/api/user/promo',
  authenticateToken,
  (req, res) => {

    const {
      code
    } = req.body;

    const promoCode =
      code &&
      code.toUpperCase();

    // Разрешён только SOGRADER10000
    if (promoCode !== 'SOGRADER10000') {

      return res.json({
        success: false,
        message: 'Неверный промокод'
      });
    }

    const db = readDB();

    // Если промокод уже использовали глобально
    if (
      db.promoCodes &&
      db.promoCodes.SOGRADER10000 &&
      db.promoCodes.SOGRADER10000.used
    ) {

      return res.json({
        success: false,
        message: 'Этот промокод уже был использован'
      });
    }

    // Создаём запись промокода, если её ещё нет
    if (!db.promoCodes) {
      db.promoCodes = {};
    }

    if (!db.promoCodes.SOGRADER10000) {
      db.promoCodes.SOGRADER10000 = {
        reward: 10000,
        used: false,
        usedBy: null,
        usedAt: null
      };
    }

    // Начисляем 10 000 Gold
    req.user.balance =
      Number(req.user.balance || 0) +
      10000;

    // Отмечаем промокод использованным
    db.promoCodes.SOGRADER10000.used =
      true;

    db.promoCodes.SOGRADER10000.usedBy =
      req.user.id;

    db.promoCodes.SOGRADER10000.usedAt =
      new Date().toISOString();

    // Обновляем пользователя в базе
    const userIndex =
      db.users.findIndex(
        user => user.id === req.user.id
      );

    if (userIndex !== -1) {
      db.users[userIndex] =
        req.user;
    }

    // Сохраняем изменения
    writeDB(db);

    return res.json({
      success: true,
      added: 10000,
      newBalance:
        req.user.balance
    });
  }
);
// ======================================================
// UPGRADE
// ======================================================

app.post(
  '/api/upgrade',
  authenticateToken,
  (req, res) => {

    const {
      selectedItemIds,
      targetItem
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

    const chance =
      (
        totalInputSum /
        targetItem.price
      ) *
      100;

    if (
      chance > 70
    ) {

      return res.json({

        success:
          false,

        message:
          'Шанс превышает допустимые 70%'
      });
    }

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
      rolled <= chance;

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
          chance
        ),

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

    saveUser(
      req.user
    );

    res.json({

      success:
        true,

      isWin:
        isWin,

      rolled:
        rolled,

      updatedInventory:
        req.user.inventory,

      bestDrop:
        req.user.bestDrop,

      upgradesCount:
        req.user.upgradesCount,

      upgradeHistory:
        req.user.upgradeHistory
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

  }
);