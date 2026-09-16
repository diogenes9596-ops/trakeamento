const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { registrarRecebimento, marcarProcessado, marcarErro } = require('../services/webhooksRecebidosService');

const router = express.Router();

function normalizarTelefone(telefone) {
  return telefone ? String(telefone).replace(/\D/g, '') : null;
}

// O DataCrazy tambem pode mandar os campos aninhados em referral, message.referral
// ou metadata, dependendo de como o evento foi originado. Aqui a gente procura
// em todos os lugares possiveis antes de desistir.
function extrairCampos(body) {
  const fontes = [body, body.referral, body.message?.referral, body.metadata];

  const campos = { phone: null, ctwa_clid: null, source_id: null, source_url: null, page_id: null };

  for (const fonte of fontes) {
    if (!fonte) continue;
    campos.phone = campos.phone || fonte.phone;
    campos.ctwa_clid = campos.ctwa_clid || fonte.ctwa_clid;
    campos.source_id = campos.source_id || fonte.source_id;
    campos.source_url = campos.source_url || fonte.source_url;
    campos.page_id = campos.page_id || fonte.page_id;
  }

  return campos;
}

// O DataCrazy (e outras integracoes) fazem um "ping" periodico via GET nesse
// mesmo endereco pra verificar se o webhook esta no ar, antes de considerar
// valido e comecar a mandar os eventos de verdade via POST. Sem responder 200
// aqui, a integracao pode nunca chegar a mandar os leads reais.
router.get('/datacrazy', (req, res) => {
  res.sendStatus(200);
});

router.post('/datacrazy', async (req, res) => {
  const secretEsperado = await obterSecret('datacrazy');
  const secretRecebido = req.headers['x-datacrazy-secret'];

  if (!secretEsperado || secretRecebido !== secretEsperado) {
    return res.sendStatus(401);
  }

  const body = req.body;

  // Grava o payload ANTES de responder "ok" -- mesmo desenho do webhook da
  // Skale (pedido do usuario em 16/09/2026). Lead perdido = venda futura sem
  // atribuicao ao anuncio. Ver src/services/webhooksRecebidosService.js.
  let recebimentoId = null;
  try {
    recebimentoId = await registrarRecebimento('datacrazy', body);
  } catch (err) {
    console.error('ERRO ao gravar o payload do webhook do DataCrazy em webhooks_recebidos -- processando antes de responder:', err);
  }

  if (!recebimentoId) {
    // Sem o registro do payload, so responde "ok" se o proprio lead foi
    // gravado; senao, 500 -- o DataCrazy fica sabendo que nao foi recebido.
    try {
      await processarEventoDatacrazy(body);
      return res.sendStatus(200);
    } catch (err) {
      console.error('ERRO ao processar webhook do DataCrazy (payload NAO registrado, respondido 500):', err);
      return res.sendStatus(500);
    }
  }

  res.sendStatus(200);

  try {
    const { idExterno } = await processarEventoDatacrazy(body);
    await marcarProcessado(recebimentoId, idExterno);
  } catch (err) {
    console.error(`ERRO ao processar webhook do DataCrazy (registro ${recebimentoId} em webhooks_recebidos):`, err);
    await marcarErro(recebimentoId, err.message, null)
      .catch((e) => console.error('ERRO ao registrar a falha do webhook do DataCrazy:', e));
  }
});

// Grava o lead. Lanca erro quando o evento nao vira lead -- quem chama decide o
// que responder pro DataCrazy e registra a falha. Devolve "lead_<id>" como
// referencia (lead nao tem id externo), que aparece no registro do evento.
async function processarEventoDatacrazy(body) {
  const { phone, ctwa_clid, source_id, source_url, page_id } = extrairCampos(body || {});

  if (!phone) {
    // Antes era so um aviso no log e o evento sumia; agora fica registrado
    // como erro, visivel em Configuracoes > Webhooks.
    console.warn('Webhook DataCrazy sem phone -- lead nao registrado.');
    throw new Error('Evento sem phone -- o lead nao pode ser registrado');
  }

  const telefone = normalizarTelefone(phone);

  const r = await pool.query(
    `INSERT INTO leads (telefone, origem, ad_id, ctwa_clid, source_url, page_id, payload_bruto)
     VALUES ($1, 'ctwa_whatsapp', $2, $3, $4, $5, $6)
     RETURNING id`,
    [telefone, source_id || null, ctwa_clid || null, source_url || null, page_id || null, JSON.stringify(body)]
  );

  console.log(`Lead DataCrazy registrado: ${telefone} <- anuncio ${source_id || 'organico'}`);

  // Envio pro Meta CAPI DESLIGADO permanentemente a pedido do usuario --
  // mesma regra ja aplicada ao webhook da Skale (ver webhookSkale.js).
  // Esse webhook so registra o lead aqui na plataforma; nada daqui deve
  // disparar evento automatico pro Meta.

  return { idExterno: `lead_${r.rows[0].id}` };
}

module.exports = router;
