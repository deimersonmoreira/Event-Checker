const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Helpers ----------
const TZ = 'America/Sao_Paulo';

function normalizeName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}
function onlyDigits(s) {
  return (s || '').replace(/\D/g, '');
}
function baseUrlFrom(req) {
  // Usa BASE_URL se existir; senão, reconstrói pela requisição
  const env = process.env.BASE_URL;
  if (env) return env.replace(/\/+$/,'');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------- Rotas de saúde ----------
app.get('/', (_req, res) => res.send('Event Checker API rodando 🎉'));
app.get('/test-db', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', time: r.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao conectar no banco' });
  }
});

// ---------- Criar evento ----------
app.post('/api/events', async (req, res) => {
  try {
    const {
      title, host_name, date, time, tz = TZ,
      location, notes = null,
      rsvp_deadline,
      color_primary = null, color_secondary = null,
      ask_email = false,
      include_maybe_in_counts = false,
      custom_messages = {}
    } = req.body || {};

    if (!title || !host_name || !date || !time || !location || !rsvp_deadline) {
      return res.status(400).json({ error: 'Campos obrigatórios: title, host_name, date, time, location, rsvp_deadline' });
    }

    const host_hash = crypto.randomBytes(16).toString('hex');

    const ins = await pool.query(
      `INSERT INTO events
       (host_hash, title, host_name, date, time, tz, location, notes, rsvp_deadline,
        include_maybe_in_counts, color_primary, color_secondary, ask_email,
        msg_thanks_going, msg_thanks_maybe, msg_thanks_notgoing,
        msg_push_24h_going, msg_push_24h_maybe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, host_hash, title, date, time, tz, location`,
      [
        host_hash, title, host_name, date, time, tz, location, notes, rsvp_deadline,
        !!include_maybe_in_counts, color_primary, color_secondary, !!ask_email,
        custom_messages.thanksGoing || null,
        custom_messages.thanksMaybe || null,
        custom_messages.thanksNotGoing || null,
        custom_messages.push24hGoing || null,
        custom_messages.push24hMaybe || null
      ]
    );

    const ev = ins.rows[0];
    const base = baseUrlFrom(req);
    const link_convidado = `${base}/rsvp/${ev.id}`;       // front usará este path
    const link_painel    = `${base}/host/${ev.id}?key=${ev.host_hash}`;

    res.json({ event_id: ev.id, link_convidado, link_painel });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar evento' });
  }
});

// ---------- Criar/atualizar RSVP (link geral) ----------
app.post('/api/rsvp/:event_id', async (req, res) => {
  try {
    const { event_id } = req.params;
    const { name, phone, email = null, status, total_people, children, honeypot = '' } = req.body || {};

    // Antispam simples
    if (honeypot && honeypot.trim() !== '') return res.status(200).json({ ok: true });

    if (!name || !phone || !status || typeof total_people !== 'number' || typeof children !== 'number') {
      return res.status(400).json({ error: 'Campos obrigatórios: name, phone, status, total_people, children' });
    }
    if (!['going','maybe','not_going'].includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    if (total_people < 1 || children < 0 || children > total_people) {
      return res.status(400).json({ error: 'Valores inválidos de pessoas/crianças' });
    }

    // Normalizações
    const name_norm = normalizeName(name);
    const phone_digits = onlyDigits(phone);

    // Obter evento (deadline etc.)
    const evq = await pool.query(`SELECT id, date, time, tz, rsvp_deadline FROM events WHERE id = $1`, [event_id]);
    if (evq.rowCount === 0) return res.status(404).json({ error: 'Evento não encontrado' });

    const ev = evq.rows[0];
    const now = new Date();
    const deadline = new Date(ev.rsvp_deadline);
    if (now > deadline) {
      return res.status(403).json({ error: 'RSVP encerrado para este evento' });
    }

    // Deduplicação simples: remove anterior e insere novo
    await pool.query(
      `DELETE FROM rsvps WHERE event_id = $1 AND name_norm = $2 AND phone = $3`,
      [event_id, name_norm, phone_digits]
    );

    const ins = await pool.query(
      `INSERT INTO rsvps
       (event_id, name_raw, name_norm, phone, email, status, total_people, children, user_agent, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, adults`,
      [
        event_id, name, name_norm, phone_digits, email, status, total_people, children,
        req.headers['user-agent'] || null,
        null // ip_hash opcional no MVP
      ]
    );

    // Calcula "edit_until" = (data+hora - 24h) em timezone do evento (assumindo SP)
    const eventDateTime = new Date(`${ev.date}T${ev.time}`);
    const editUntil = new Date(eventDateTime.getTime() - 24 * 60 * 60 * 1000);

    res.json({
      rsvp_id: ins.rows[0].id,
      status,
      adults: ins.rows[0].adults,
      edit_until: editUntil.toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar RSVP' });
  }
});

// ---------- Resumo (KPIs) ----------
app.get('/api/events/:id/summary', async (req, res) => {
  try {
    const { id } = req.params;
    const { key } = req.query;
    // valida host_hash (acesso do painel)
    const evq = await pool.query(`SELECT id, include_maybe_in_counts FROM events WHERE id = $1`, [id]);
    if (evq.rowCount === 0) return res.status(404).json({ error: 'Evento não encontrado' });

    // (MVP sem checagem rígida do host_hash na rota pública — pode ativar depois)
    // Para checar de fato, descomente:
    // const kq = await pool.query(`SELECT 1 FROM events WHERE id=$1 AND host_hash=$2`, [id, key]);
    // if (kq.rowCount === 0) return res.status(403).json({ error: 'Acesso não autorizado' });

    const includeMaybe = !!evq.rows[0].include_maybe_in_counts;

    // Totais por status
    const statusAgg = await pool.query(
      `SELECT
          COUNT(*)::int as all,
          SUM((status='going')::int)::int as going,
          SUM((status='maybe')::int)::int as maybe,
          SUM((status='not_going')::int)::int as not_going
       FROM rsvps
       WHERE event_id = $1`, [id]
    );

    // Adultos/crianças segundo toggle
    const baseStatuses = includeMaybe ? ['going','maybe'] : ['going'];
    const adultsChildren = await pool.query(
      `SELECT
          COALESCE(SUM(adults),0)::int as adults,
          COALESCE(SUM(children),0)::int as children
       FROM rsvps
       WHERE event_id = $1 AND status = ANY($2::text[])`,
      [id, baseStatuses]
    );

    res.json({
      totals: {
        ...statusAgg.rows[0],
        ...adultsChildren.rows[0],
        include_maybe_in_counts: includeMaybe
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao calcular KPIs' });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Servidor rodando na porta ${port}`));

