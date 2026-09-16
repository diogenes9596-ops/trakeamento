const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');

const GRAPH_VERSION = 'v21.0';

function sha256(valor) {
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

// Telefone no formato E.164 (sÃÂÃÂ³ dÃÂÃÂ­gitos, com DDI), depois hasheado ÃÂ¢ÃÂÃÂ exigÃÂÃÂªncia da Meta
function hashTelefone(telefone) {
  const digitos = String(telefone).replace(/\D/g, '');
  return sha256(digitos);
}

async function buscarPixelParaEvento(tipoEvento) {
  // tipoEvento: 'Lead' ou 'Purchase'
  // Pixels com eventos_capi = 'venda_agendamento' recebem tanto Lead quanto Purchase;
  // pixels com 'venda' sÃÂÃÂ³ recebem Purchase.
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
    console.log(`Nenhum pixel default configurado para receber evento ${evento} ÃÂ¢ÃÂÃÂ pulei o envio.`);
    return { ok: false, erro: 'Nenhum pixel padrao configurado (Configuracoes > Pixels)' };
  }

  // Devolve { ok, erro } -- antes nao devolvia nada, e quem chamava contava
  // como "enviado" ate envio recusado pelo Meta ou sem pixel configurado.
  const payloadEvento = {
    event_name: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId, // mesmo event_id usado no Pixel do navegador, pra deduplicar
    // REVERTIDO em 16/09/2026: 'business_messaging' + 'messaging_channel' causava
    // erro "Invalid parameter" do Meta em TODOS os envios (falha total, pior
    // que o problema de atribuicao que essa mudanca tentava resolver).
    // Precisa investigar o formato/endpoint correto antes de tentar de novo.
    action_source: 'system_generated',
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
    return { ok: true };
  } catch (err) {
    const mensagem = err.response?.data?.error?.message || err.message;
    console.error(`Erro ao enviar evento ${evento} pro CAPI:`, mensagem);
    await pool.query(
      `INSERT INTO eventos_capi (evento, telefone, pixel_id, status, payload, erro_mensagem)
       VALUES ($1, $2, $3, 'erro', $4, $5)`,
      [evento, telefone, pixel.pixel_id, JSON.stringify({ enviado: payloadEvento }), mensagem]
    );
    return { ok: false, erro: mensagem };
  }
}

module.exports = { enviarEventoCapi, hashTelefone };
