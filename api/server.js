// Força preferência por IPv4 (evita ENETUNREACH em alguns provedores)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./db'); // db.js na mesma pasta (Pool do 'pg' com SSL)

// ---------- App ----------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Constantes / Helpers ----------
const TZ = 'America/Sao_Paulo';

// normaliza nome para deduplicação simples (sem acento, minúsculas, espaços únicos)
function normalizeName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

function onlyDigits(s) {
  return (s || '').replace(/\D/g, '');
}

function baseUrlFrom(req) {
  // Você pode definir BASE_URL nas variáveis do Render; se não, usa host do request
  const env = process.env.BASE_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Monta "YYYY-MM-DDTHH:mm:00-03:00" a partir de "YYYY-MM-DD" e "HH:mm"
function toISOWithTZ(dateStr, timeStr, tzOffset = '-03:00') {
  if (!dateStr || !timeStr) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && /^\d{2}:\d{2}$/.test(timeStr);
  if (!ok) return null;
  return `${dateStr}T${timeStr}:00${tzOffset}`;
}

function isoFromDate(d) {
  const pad = n => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00-03:00`;
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

// ---------- Criar evento (servidor formata data-limite) ----------
app.post('/api/events', async (req, res) => {
  try {
    const {
      title,            // obrigatório
      host_name,        // obrigatório
      date,             // "YYYY-MM-DD" obrigatório
      time,             // "HH:mm" (24h) obrigatório
      tz = TZ,
      location,         // obrigatório
      notes = null,

      // NOVO: cliente pode mandar desmembrado (opcional)
      rsvp_deadline_date, // "YYYY-MM-DD" (opcional)
      rsvp_deadline_time, // "HH:mm" (opcional)

      // legado: se vier pronto em ISO, ainda aceitamos
      rsvp_deadline,

      color_primary = null,
      color_secondary = null,
      ask_email = false,
      include_maybe_in_counts = false,
      custom_messages = {}
    } = req.body || {};

    if (!title || !host_name || !date || !time || !location) {
      return res.status(400).json({
        error: 'Campos obrigatórios: title, host_name, date, time, location'
      });
    }

    // Monta ISO do evento (com -03:00)
    const eventISO = toISOWithTZ(date, time);
    if (!eventISO) {
      return res.status(400).json({
        error: 'Formato inválido de data/horário do evento (use data "YYYY-MM-DD" e hora "HH:mm")'
      });
    }
    const eventDateObj = new Date(eventISO);

    // Define deadline final:
    // 1) prioridade: campos desmembrados se ambos vierem
    // 2) senão, aceita rsvp_deadline legado (ISO)
    // 3) fallback: 24h antes do evento
    let finalDeadlineISO = null;

    if (rsvp_deadline_date && rsvp_deadline_time) {
      finalDeadlineISO = toISOWithTZ(rsvp_deadline_date, rsvp_deadline_time);
    } else if (rsvp_deadline) {
      finalDeadlineISO = rsvp_deadline;
    }

    if (!finalDeadlineISO) {
      const fallback = new Date(eventDateObj.getTime() - 24 * 60 * 60 * 1000);
      finalDeadlineISO = isoFromDate(fallback);
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
        host_hash, title, host_name, date, time, tz, location, notes, finalDeadlineISO,
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
    const link_convidado = `${base}/rsvp/${ev.id}`;            // caminho reservado para um futuro front server-side
    const link_painel    = `${base}/host/${ev.id}?key=${ev.host_hash}`;

    res.json({
      event_id: ev.id,
      link_convidado,
      link_painel,
      rsvp_deadline_iso: finalDeadlineISO
    });
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

    // Antispam simples (campo oculto deve ficar vazio)
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
    const evq = await pool.query(
      `SELECT id, date, time, tz, rsvp_deadline FROM events WHERE id = $1`,
      [event_id]
    );
    if (evq.rowCount === 0) return res.status(404).json({ error: 'Evento não encontrado' });

    const ev = evq.rows[0];

    // Bloqueio por data-limite (rsvp_deadline)
    const now = new Date();
    const deadline = new Date(ev.rsvp_deadline);
    if (now > deadline) {
      return res.status(403).json({ error: 'RSVP encerrado para este evento' });
    }

    // Deduplicação: remove anterior (mesmo evento, mesmo nome normalizado e phone) e insere nova
    await pool.query(
      `DELETE FROM rsvps WHERE event_id = $1 AND name_norm = $2 AND phone = $3`,
      [event_id, name_norm, phone_digits]
    );

    const ins = await pool.query(
      `INSERT INTO rsvps
       (event_id, name_raw, name_norm, phone, email, status, total_people, children, user_agent, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, (total_people - children) AS adults`,
      [
        event_id, name, name_norm, phone_digits, email, status, total_people, children,
        req.headers['user-agent'] || null,
        null // ip_hash opcional no MVP
      ]
    );

    // Calcula "edit_until" = (data+hora - 24h) no fuso do evento (simplificado com -03:00)
    const eventISO = toISOWithTZ(ev.date, ev.time);
    const eventDateTime = new Date(eventISO);
    const editUntil = new Date(eventDateTime.getTime() - 24 * 60 * 60 * 1000);

    res.json({
      rsvp_id: ins.rows[0].id,
      status,
      adults: Number(ins.rows[0].adults) || 0,
      edit_until: editUntil.toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar RSVP' });
  }
});

// ---------- Resumo (KPIs para o anfitrião) ----------
app.get('/api/events/:id/summary', async (req, res) => {
  try {
    const { id } = req.params;
    const { key } = req.query;

    // Busca evento e a regra de contagem do "Talvez"
    const evq = await pool.query(
      `SELECT id, include_maybe_in_counts FROM events WHERE id = $1`,
      [id]
    );
    if (evq.rowCount === 0) return res.status(404).json({ error: 'Evento não encontrado' });

    // (MVP: sem exigir host_hash. Para travar o painel, habilite o check abaixo)
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
       WHERE event_id = $1`,
      [id]
    );

    // Adultos/crianças somando "going" e, opcionalmente, "maybe"
    const baseStatuses = includeMaybe ? ['going','maybe'] : ['going'];
    const adultsChildren = await pool.query(
      `SELECT
          COALESCE(SUM(total_people - children),0)::int AS adults,
          COALESCE(SUM(children),0)::int AS children
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
