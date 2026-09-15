const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');

const GRAPH_VERSION = 'v21.0';

function sha256(valor) {
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

// Telefone no formato E.164 (sÃÂ³ dÃÂ­gitos, com DDI), depois hasheado Ã¢ÂÂ exigÃÂªncia da Meta
function hashTelefone(telefone) {
  const digitos = String(telefone).replace(/\D/g, '');
  return sha256(digitos);
}

async function buscarPixelParaEvento(tipoEvento) {
  // tipoEvento: 'Lead' ou 'Purchase'
  // Pixels com eventos_capi = 'venda_agendamento' recebem tanto Lead quanto Purchase;
  // pixels com 'venda' sÃÂ³ recebem Purchase.
  const result = await pool.query(
    `SELECT * FROM pixels
     WHERE is_default = TRUE
       AND ($1 = 'Purchase' OR eventos_capi = 'venda_agendamento')
     LIMIT 1`,
    [tipoEvento]
  );
  return result.rows[0] || null;
}

async function enviarEventoCapi({ evento, telefone, eventSourceUrl, valor, moeda = 'BRL', eventId, ctwaClid }) {
  const pixel = await buscarPixelParaEvento(evento);

  if (!pixel) {
    console.log(`Nenhum pixel default configurado para receber evento ${evento} Ã¢ÂÂ pulei o envio.`);
    return;
  }

  const payloadEvento = {
    event_name: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId, // mesmo event_id usado no Pixel do navegador, pra deduplicar
    action_source: evento === 'Purchase' ? 'business_messaging' : 'system_generated',
    // messaging_channel e obrigatorio pro Meta reconhecer que a conversao veio
    // de uma conversa de WhatsApp originada por anuncio (CTWA) -- sem isso,
    // mesmo mandando o ctwa_clid certo, o Meta nao credita o Purchase ao
    // anuncio certo e cai no proprio modelo de atribuicao dele (Last Click,
    // 7 dias), que pode bater numa campanha totalmente diferente.
    messaging_channel: 'whatsapp',
    user_data: {
      ph: [hashTelefone(telefone)],
      // ctwa_clid liga o evento de volta ao clique no anuncio que originou a
      // conversa no WhatsApp -- sem isso, o Meta so tem o telefone (hash) pra
      // tentar casar o Purchase com o anuncio, o que e bem mais fraco.
      ...(ctwaClid ? { ctwa_clid: ctwaClid } : {}),
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
