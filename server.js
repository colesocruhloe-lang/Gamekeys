
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://colesocruhloe-lang.github.io";

app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const WALLET = process.env.TRON_WALLET_ADDRESS;
const TRONSCAN_KEY = process.env.TRONSCAN_API_KEY;

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PRICE_RAW = "45000000";
const PRODUCT = "GTA VI";

const PRODUCT_KEY =
  process.env.PRODUCT_KEY || "FKEY-7XQ9-M2PL-8K4N";

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      product TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT UNIQUE,
      code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);
}

function makeId() {
  return crypto.randomUUID();
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const id = makeId();

    await pool.query(
      `INSERT INTO orders
       (id, product, amount_raw, status)
       VALUES ($1, $2, $3, 'pending')`,
      [id, PRODUCT, PRICE_RAW]
    );

    res.json({
      success: true,
      orderId: id,
      product: PRODUCT,
      amount: "45",
      currency: "USDT",
      network: "TRC20",
      address: WALLET
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      error: "Unable to create the order"
    });
  }
});

app.get("/api/order/:orderId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product, status, code, created_at, paid_at
       FROM orders WHERE id = $1`,
      [req.params.orderId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

async function findPayment() {
  if (!WALLET) throw new Error("TRON_WALLET_ADDRESS is not configured");

  const url =
    "https://apilist.tronscanapi.com/api/token_trc20/transfers" +
    `?contract_address=${encodeURIComponent(USDT_CONTRACT)}` +
    `&toAddress=${encodeURIComponent(WALLET)}` +
    "&direction=in" +
    "&limit=50" +
    "&start=0" +
    "&confirm=0";

  const response = await fetch(url, {
    headers: TRONSCAN_KEY
      ? { "TRON-PRO-API-KEY": TRONSCAN_KEY }
      : {}
  });

  if (!response.ok) {
    throw new Error(`TronScan HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.token_transfers || []).find((tx) => {
    return (
      tx.contract_address === USDT_CONTRACT &&
      tx.to_address === WALLET &&
      tx.quant === PRICE_RAW &&
      tx.event_type === "Transfer" &&
      tx.confirmed === true &&
      tx.finalResult === "SUCCESS"
    );
  });
}

app.post("/api/order/:orderId/verify", async (req, res) => {
  const client = await pool.connect();

  try {
    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [req.params.orderId]
    );

    if (!orderResult.rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderResult.rows[0];

    if (order.status === "paid") {
      return res.json({
        success: true,
        status: "paid",
        code: order.code
      });
    }

    const payment = await findPayment();

    if (!payment) {
      return res.json({
        success: true,
        status: "pending"
      });
    }

    const txHash =
      payment.transaction_id ||
      payment.hash;

    if (!txHash) {
      return res.json({
        success: true,
        status: "pending"
      });
    }

    const used = await client.query(
      `SELECT id FROM orders
       WHERE tx_hash = $1
       LIMIT 1`,
      [txHash]
    );

    if (used.rows.length) {
      return res.status(409).json({
        success: false,
        error: "Transaction already used"
      });
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE orders
       SET status = 'paid',
           tx_hash = $1,
           code = $2,
           paid_at = NOW()
       WHERE id = $3`,
      [txHash, PRODUCT_KEY, order.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      status: "paid",
      code: PRODUCT_KEY
    });

  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error(e);

    res.status(500).json({
      success: false,
      error: "Verification failed"
    });
  } finally {
    client.release();
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GameKeys backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
