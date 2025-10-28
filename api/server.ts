const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// teste simples
app.get('/', (_req, res) => res.send('Event Checker API rodando 🎉'));

// teste de banco
app.get('/test-db', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao conectar no banco' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Servidor rodando na porta ${port}`));
