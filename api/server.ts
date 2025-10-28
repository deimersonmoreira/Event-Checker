import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import pool from './db.js'; // mantém .js, porque o Node importará o JS compilado

const app = express();
app.use(cors());
app.use(bodyParser.json());

// teste simples de conexão
app.get('/', (_req: Request, res: Response) => {
  res.send('Event Checker API rodando 🎉');
});

// rota de teste no banco
app.get('/test-db', async (_req: Request, res: Response) => {
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
