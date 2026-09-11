const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { atribuirVendasPendentes } = require('../services/attributionService');
const { enviarEventoCapi } = require('../services/metaCapiService');

const router = express.Router();

// A Skale usa esse vocabulario em PORTUGUES pro status financeiro do pedido
// (confirmado direto na API dela, campo "Status Pagamento").
// IMPORTANTE: a deteccao de status usa campos ESPECIFICOS do payload
// (transaction.payment_status / skaletracking.status_pagamento), nunca uma
// busca cega por qualquer valor -- uma versao antiga desse codigo procurava
// "o primeiro valor que bater com um status conhecido em qualquer lugar do
// payload", o que confundia transaction.payment_method="After Pay" (a
// FORMA de pagamento) com transaction.payment_status="Pago" (o status real).
// Como "payment_method" aparece antes de "payment_status" no JSON da Skale,
// pedidos After Pay que JA FORAM PAGOS ficavam presos como "agendamento"
// pra sempre, nunca virando "aprovada".
const STATUS_CANCELADO = ['cancelado', 'estornado', 'chargeback', 'reprovado', 'devolvido', 'frustrado', 'suspenso'];

// Procura, em qualquer nivel do payload, um VALOR que bata com uma lista de
// sinonimos -- usado só pra cancelamento, que pode vir com varias palavras
// diferentes e em campos menos previsíveis. NUNCA usar isso pra detectar
// "pago" nem "after pay", que precisam vir de um campo especifico (ver acima).
function buscarValorConhecido(obj, lista, profundidade = 0) {
  if (!obj || typeof obj !== 'object' || profundidade > 6) return null;
  for (const valor of Object.values(obj)) {
    if (typeof valor === 'string') {
      const normalizado = valor.trim().toLowerCase();
      if (lista.includes(normalizado)) return normalizado;
    }
  }
  for (const valor of Object.values(obj)) {
    if (valor && typeof valor === 'object') {
      const achado = buscarValorConhecido(valor, lista, profundidade + 1);
      if (achado) return achado;
    }
  }
  return null;
}

// Tenta uma lista de "caminhos" (funcoes) no payload, em ordem, e devolve o
// primeiro valor nao vazio. Usado pra cobrir os formatos mais prováveis que
// a Skale pode usar pra cada campo, ja que nao temos um payload real
// confirmado ainda -- fica facil adicionar mais um caminho se precisar.
function primeiroValor(body, caminhos) {
  for (const c of caminhos) {
    try {
      const v = c(body);
      if (v !== undefined && v !== null && v !== '') return v;
    } catch (e) { /* caminho nao existe nesse payload, tenta o proximo */ }
  }
  return undefined;
}

// Ping de verificacao (GET) que algumas integracoes mandam antes de comecar
// a enviar os eventos de verdade via POST -- sem isso, a Skale pode considerar
// o webhook invalido e nunca mandar as vendas de verdade.
router.get('/skale', (req, res) => {
  res.sendStatus(200);
});

router.post('/skale', async (req, res) => {
  const secretEsperado = await obterSecret('skale');
  const secretQuery = req.query.token;
  const secretHeader = req.headers['x-skale-secret'];

  // Loga TODA tentativa de chegada, mesmo antes de validar o token -- se o
  // token estiver errado/ausente, isso e o UNICO rastro que fica (o retorno
  // 401 abaixo nao aparece nos Deploy Logs, so nos Network Logs).
  console.log('Webhook Skale -- tentativa recebida. Token na URL:', secretQuery ? '(presente)' : '(ausente)',
    '| Header x-skale-secret:', secretHeader ? '(presente)' : '(ausente)');

  if (!secretEsperado || (secretQuery !== secretEsperado && secretHeader !== secretEsperado)) {
    console.warn('Webhook Skale REJEITADO: token nao confere.');
    return res.sendStatus(401);
  }

  const body = req.body;
  // Log completo (sem cortar) -- essencial pra conferir/ajustar o mapeamento
  // de campos caso a Skale use um formato diferente do que previmos abaixo.
  console.log('Webhook Skale recebido (payload completo):', JSON.stringify(body));

  res.sendStatus(200);

  try {
    const idExterno = primeiroValor(body, [
      b => b.id_venda, b => b.id_pedido, b => b.pedido?.id, b => b.venda?.id,
      b => b.order_id, b => b.transaction_id, b => b.numero_pedido, b => b.codigo_pedido, b => b.id,
    ]);
    if (!idExterno) {
      console.warn('Webhook Skale sem id do pedido identificavel. Payload:', JSON.stringify(body).slice(0, 1000));
      return;
    }
    const idExternoTexto = String(idExterno);

    let telefone = String(primeiroValor(body, [
      b => b.cliente?.telefone, b => b.customer?.phone, b => b.telefone,
      b => b.cliente?.celular, b => b.cliente?.whatsapp, b => b.whatsapp,
    ]) || '').replace(/\D/g, '');
    if (telefone && !telefone.startsWith('55')) {
      telefone = '55' + telefone;
    }

    const email = primeiroValor(body, [
      b => b.cliente?.email, b => b.customer?.email, b => b.email,
    ]);
    const nomeCliente = primeiroValor(body, [
      b => b.cliente?.nome, b => b.customer?.name, b => b.nome_cliente, b => b.nome,
    ]);
    const produto = primeiroValor(body, [
      b => b.kits?.[0]?.nome, b => b.kit?.nome, b => b.produtos?.[0]?.nome,
      b => b.product?.name, b => b.produto,
    ]);

    let valorBruto = parseFloat(primeiroValor(body, [
      b => b.valor_pago, b => b.valor, b => b.pedido?.valor, b => b.total,
      b => b.transaction?.total_price, b => b.total_price,
    ]) || 0);
    // Se algum dia a Skale mandar em centavos (numero bem maior que o
    // ticket medio dessa loja), corrige dividindo por 100.
    const valor = valorBruto > 10000 ? valorBruto / 100 : valorBruto;

    // Campos ESPECIFICOS (nao busca cega) -- confirmados com payloads reais
    // da Skale: transaction.payment_status é o status financeiro de verdade
    // ("Pago", "Aguardando Pagamento", "After Pay", "Recusado"...), e
    // transaction.payment_method é a FORMA escolhida pelo cliente
    // ("Antecipada" = paga na hora, "After Pay" = paga na entrega).
    // skaletracking.status_pagamento é usado como reforço/fallback.
    const statusPagamento = String(
      body?.transaction?.payment_status || body?.skaletracking?.status_pagamento || ''
    ).trim().toLowerCase();
    const formaPagamento = String(body?.transaction?.payment_method || '').trim().toLowerCase();

    const pago = statusPagamento === 'pago';
    const recusado = statusPagamento.includes('recus');
    const cancelado = !recusado && (
      STATUS_CANCELADO.includes(statusPagamento) || !!buscarValorConhecido(body, STATUS_CANCELADO)
    );
    const isAfterPay = formaPagamento === 'after pay' || formaPagamento === 'afterpay';

    // Regra da Skale (Pay After Delivery):
    // - After Pay ainda nao pago -> vira AGENDAMENTO (fica atribuido por
    //   telefone, mas NAO dispara Purchase pro Meta ainda -- desligado)
    // - qualquer pedido (Antecipada ou After Pay) com pagamento confirmado
    //   -> vira VENDA de verdade (aprovada)
    // - Antecipada (Pix/cartao) ainda aguardando confirmacao -> nao e venda
    //   nem entrega agendada; a propria Skale tambem exclui isso do
    //   faturamento dela. Fica "desconhecido" (aparece como Pendente no
    //   painel) ate o proximo evento (pago/recusado/cancelado) atualizar.
    let status;
    if (cancelado) {
      status = 'cancelada';
    } else if (recusado) {
      status = 'recusada';
    } else if (pago) {
      status = 'aprovada';
    } else if (isAfterPay) {
      status = 'agendamento';
    } else {
      status = 'desconhecido';
    }

    await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto)
       VALUES ('skale', $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (plataforma, id_externo)
       DO UPDATE SET status = EXCLUDED.status, valor = EXCLUDED.valor, atribuido_em = NULL`,
      [idExternoTexto, status, telefone, email, nomeCliente, valor, produto, JSON.stringify(body)]
    );

    await atribuirVendasPendentes();

    // Envio pro Meta DESLIGADO permanentemente a pedido do usuario -- a
    // funcao desse webhook e so puxar da Skale e marcar aqui na plataforma
    // (pedido criado -> agendamento, pagamento aprovado -> vendas). Nada
    // disso deve disparar evento pro Meta.
  } catch (err) {
    console.error('Erro ao processar webhook da Skale:', err);
  }
});

module.exports = router;
