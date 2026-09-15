const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');

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

  res.sendStatus(200); // responde rapido, processa depois

  try {
    const { phone, ctwa_clid, source_id, source_url, page_id } = extrairCampos(req.body);

    if (!phone) {
      console.warn('Webhook DataCrazy sem phone â payload ignorado.');
      return;
    }

    const telefone = normalizarTelefone(phone);

    await pool.query(
      `INSERT INTO leads (telefone, origem, ad_id, ctwa_clid, source_url, page_id, payload_bruto)
       VALUES ($1, 'ctwa_whatsapp', $2, $3, $4, $5, $6)`,
      [telefone, source_id || null, ctwa_clid || null, source_url || null, page_id || null, JSON.stringify(req.body)]
    );

    console.log(`Lead DataCrazy registrado: ${telefone} <- anuncio ${source_id || 'organico'}`);

    // Envio pro Meta CAPI DESLIGADO permanentemente a pedido do usuario --
    // mesma regra ja aplicada ao webhook da Skale (ver webhookSkale.js).
    // Esse webhook so registra o lead aqui na plataforma; nada daqui deve
    // disparar evento automatico pro Meta.
  } catch (err) {
    console.error('Erro ao processar webhook do DataCrazy:', err);
  }
});

module.exports = router;
