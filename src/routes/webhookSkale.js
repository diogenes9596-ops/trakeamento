const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { atribuirVendasPendentes } = require('../services/attributionService');
const { enviarEventoCapi } = require('../services/metaCapiService');

const router = express.Router();

// Status de pagamento que indicam que o dinheiro realmente entrou
const STATUS_PAGO = ['payment_confirmed', 'payment_registered', 'order_paid_manual'];

router.post('/skale', async (req, res) => {
  const secretEsperado = await obterSecret('skale');
  const secretQuery = req.query.token;
  const secretHeader = req.headers['x-skale-secret'];

  if (!secretEsperado || (secretQuery !== secretEsperado && secretHeader !== secretEsperado)) {
    return res.sendStatus(401);
  }

  const body = req.body;
  console.log('Webhook Skale recebido:', JSON.stringify(body).slice(0, 2000));

  res.sendStatus(200);

  try {
    const idExterno = body.transaction_id;
    if (!idExterno) {
      console.warn('Webhook Skale sem transaction_id.');
      return;
    }

    const cliente = body.customer || {};
    // A Skale manda o telefone sem o DDI do pais (55) — a gente adiciona automaticamente
    let telefone = (cliente.phone || '').replace(/\D/g, '');
    if (telefone && !telefone.startsWith('55')) {
      telefone = '55' + telefone;
    }

    const email = cliente.email;
    const nomeCliente = cliente.name;
    const produto = body.product?.name;

    const transacao = body.transaction || {};
    const valor = parseFloat(transacao.total_price || 0) / 100; // vem em centavos
    const metodoPagamento = (transacao.payment_method || '').toLowerCase();
    const statusPagamentoBruto = (transacao.payment_status || '').toLowerCase();
    const eventoSkale = (body.skaletracking?.event || '').toLowerCase();
    const pago = STATUS_PAGO.includes(statusPagamentoBruto) || !!transacao.paid_at;

    // Regra da Skale (Pay After Delivery):
    // - pedido criado com pagamento "After Pay" e ainda nao pago -> vira AGENDAMENTO
    //   (fica atribuido por telefone, mas NAO dispara Purchase pro Meta ainda)
    // - quando o pagamento confirma depois -> vira VENDA de verdade e dispara Purchase
    let status;
    if (pago) {
      status = 'aprovada';
    } else if (metodoPagamento.includes('after pay') || metodoPagamento.includes('afterpay')) {
      status = 'agendamento';
    } else if (eventoSkale === 'order_created') {
      status = 'aguardando';
    } else {
      status = statusPagamentoBruto || 'desconhecido';
    }

    await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto)
       VALUES ('skale', $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (plataforma, id_externo)
       DO UPDATE SET status = EXCLUDED.status, valor = EXCLUDED.valor, atribuido_em = NULL`,
      [idExterno, status, telefone, email, nomeCliente, valor, produto, JSON.stringify(body)]
    );

    await atribuirVendasPendentes();

    // So dispara Purchase pro Meta quando o pagamento realmente confirma
    // (o agendamento nao conta como conversao ainda)
    if (status === 'aprovada') {
      await enviarEventoCapi({ evento: 'Purchase', telefone, valor, eventId: `skale_${idExterno}` });
    }
  } catch (err) {
    console.error('Erro ao processar webhook da Skale:', err);
  }
});

module.exports = router;
