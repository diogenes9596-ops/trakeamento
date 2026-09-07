const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');

const GRAPH_VERSION = 'v21.0';

function sha256(valor) {
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

// Telefone no formato E.164 (só dígitos, com DDI), depois hasheado — exigência da Meta
function hashTelefone(telefone) {
  const digitos = String(telefone).replace(/\D/g, '');
  return sha256(digitos);
}

async function buscarPixelParaEvento(tipoEvento) {
  // tipoEvento: 'Lead' ou 'Purchase'
  // Pixels com eventos_capi = 'venda_agendamento' recebem tanto Lead quanto Purchase;
  // pixels com 'venda' só recebem Purchase.
  const result = await pool.query(
    `SELECT * FROM pixels
     WHERE is_default = TRUE
       AND ($1 = 'Purchase' OR eventos_capi = 'venda_agendamento')
     LIMIT 1`,
    [tipoEvento]
  );
  return result.rows[0] || null;
}

async function enviarEventoCapi({ evento, telefone, eventSourceUrl, valor, moeda = 'BRL', eventId }) {
  const pixel = await buscarPixelParaEvento(evento);

  if (!pixel) {
    console.log(`Nenhum pixel default configurado para receber evento ${evento} — pulei o envio.`);
    return;
  }

  const payloadEvento = {
    event_name: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId, // mesmo event_id usado no Pixel do navegador, pra deduplicar
    action_source: 'system_generated',
    user_data: {
      ph: [hashTelefone(telefone)],
    },
    ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
    ...(evento === 'Purchase' ? { custom_data: { value: valor, currency: moeda } } : {}),
  };

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixel.pixel_id}/events`;
    const { data } = await axios.post(url, {
      data: [payloadEvento],
      access_token: pixel.access_token,
    });

    await pool.query(
      `INSERT INTO eventos_capi (evento, telefone, pixel_id, status, payload)
       VALUES ($1, $2, $3, 'ok', $4)`,
      [evento, telefone, pixel.pixel_id, JSON.stringify({ enviado: payloadEvento, resposta: data })]
    );
  } catch (err) {
    const mensagem = err.response?.data?.error?.message || err.message;
    console.error(`Erro ao enviar evento ${evento} pro CAPI:`, mensagem);
    await pool.query(
      `INSERT INTO eventos_capi (evento, telefone, pixel_id, status, payload, erro_mensagem)
       VALUES ($1, $2, $3, 'erro', $4, $5)`,
      [evento, telefone, pixel.pixel_id, JSON.stringify({ enviado: payloadEvento }), mensagem]
    );
  }
}

module.exports = { enviarEventoCapi, hashTelefone };
