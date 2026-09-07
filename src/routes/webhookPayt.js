const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { atribuirVendasPendentes } = require('../services/attributionService');
const { enviarEventoCapi } = require('../services/metaCapiService');

const router = express.Router();

const MAPA_STATUS = {
  aprovada: 'aprovada',
  approved: 'aprovada',
  paid: 'aprovada',
  finalizada: 'aprovada',
  cancelada: 'cancelada',
  canceled: 'cancelada',
  aguardando_pagamento: 'aguardando',
  pending: 'aguardando',
  abandono_checkout: 'abandonada',
  abandoned: 'abandonada',
  reembolsada: 'reembolsada',
  refunded: 'reembolsada',
  recusada: 'recusada',
  refused: 'recusada',
};

// A Payt manda o valor liquido (depois de taxas) que vai pro produtor dentro
// de um array "commission", com um item por parte (produtor, afiliado,
// plataforma, etc). A gente procura o item cujo destinatario e o "producer"
// (voce, o dono do produto) e usa o valor dele.
// AJUSTE: quando tiver um payload real da Payt, confirme o nome exato dos
// campos abaixo (recipient/type/value podem ter nomes ligeiramente diferentes).
function extrairValorProdutor(body) {
  const commission = body.commission || body.commissions || [];
  if (!Array.isArray(commission) || commission.length === 0) {
    return parseFloat(body.value || body.valor || body.amount || 0);
  }

  const itemProdutor = commission.find((item) => {
    const tipo = (item.recipient_type || item.type || item.recipient || '').toString().toLowerCase();
    return tipo.includes('produc') || tipo.includes('produt'); // "producer" / "produtor"
  });

  const itemEscolhido = itemProdutor || commission[0];
  const valor = itemEscolhido?.value ?? itemEscolhido?.amount ?? 0;
  return parseFloat(valor);
}

function extrairEmailAfiliado(body) {
  return (
    body.affiliate?.email ||
    body.afiliado?.email ||
    body.affiliate_email ||
    null
  );
}

async function afiliadoAutorizado(email) {
  if (!email) return true; // sem afiliado (venda direta) sempre processa
  const result = await pool.query('SELECT id FROM atendentes WHERE email = $1 AND ativo = TRUE', [email]);
  return result.rows.length > 0;
}

// Ping de verificacao (GET) que algumas integracoes mandam antes de comecar
// a enviar os eventos de verdade via POST -- sem isso, a Payt pode considerar
// o webhook invalido e nunca mandar as vendas de verdade.
router.get('/payt', (req, res) => {
  res.sendStatus(200);
});

router.post('/payt', async (req, res) => {
  const secretEsperado = await obterSecret('payt');
  const secretRecebido = req.query.token;

  if (!secretEsperado || secretRecebido !== secretEsperado) {
    return res.sendStatus(401);
  }

  const body = req.body;
  console.log('Webhook Payt recebido:', JSON.stringify(body).slice(0, 2000));

  res.sendStatus(200);

  try {
    const emailAfiliado = extrairEmailAfiliado(body);
    const autorizado = await afiliadoAutorizado(emailAfiliado);

    if (!autorizado) {
      console.log(`Venda da Payt ignorada — afiliado "${emailAfiliado}" nao esta na lista de atendentes.`);
      return;
    }

    const idExterno = body.id || body.transaction_id || body.order_id;
    const statusBruto = (body.status || body.event || '').toString().toLowerCase();
    const status = MAPA_STATUS[statusBruto] || statusBruto || 'desconhecido';

    const cliente = body.customer || body.cliente || {};
    const telefone = (cliente.phone || cliente.telefone || body.phone || '').replace(/\D/g, '') || null;
    const email = cliente.email || body.email;
    const nomeCliente = cliente.name || cliente.nome;

    const valor = extrairValorProdutor(body);
    const produto = body.product?.name || body.produto || body.offer_name;

    if (!idExterno) {
      console.warn('Webhook Payt sem id externo identificavel.');
      return;
    }

    await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, afiliado_email, payload_bruto)
       VALUES ('payt', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (plataforma, id_externo)
       DO UPDATE SET status = EXCLUDED.status, valor = EXCLUDED.valor, atribuido_em = NULL`,
      [idExterno, status, telefone, email, nomeCliente, valor, produto, emailAfiliado, JSON.stringify(body)]
    );

    // Roda a atribuicao na hora pra essa venda especifica (nao precisa esperar o cron)
    await atribuirVendasPendentes();

    if (status === 'aprovada') {
      await enviarEventoCapi({ evento: 'Purchase', telefone, valor, eventId: `payt_${idExterno}` });
    }
  } catch (err) {
    console.error('Erro ao processar webhook da Payt:', err);
  }
});

module.exports = router;
