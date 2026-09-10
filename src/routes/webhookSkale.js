const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { atribuirVendasPendentes } = require('../services/attributionService');
const { enviarEventoCapi } = require('../services/metaCapiService');

const router = express.Router();

// A Skale usa esse vocabulario em PORTUGUES pro status financeiro do pedido
// (confirmado direto na API dela, campo "Status Pagamento") -- nosso codigo
// antigo procurava strings em ingles ('payment_confirmed') que a Skale nunca
// manda, por isso nenhuma venda estava sendo marcada.
const STATUS_PAGO = ['pago'];
const STATUS_CANCELADO = ['cancelado', 'estornado', 'chargeback', 'reprovado', 'devolvido', 'frustrado'];
// Pedido recem-criado que ainda vai ser pago na entrega (Pay After Delivery).
// Confirmado com um payload real de teste da Skale: o evento "order_created"
// manda payment_status = "Aguardando Pagamento" (nao "After Pay" como a gente
// tinha assumido antes por engano) -- mantemos os dois por seguranca.
const STATUS_AFTER_PAY = ['after pay', 'afterpay', 'aguardando pagamento'];

// Procura, em qualquer nivel do payload (nao sabemos o nome exato da chave
// nem a profundidade), um VALOR que bata com um dos status conhecidos da
// Skale. Assim a deteccao funciona mesmo se o campo se chamar
// status_pagamento, statusPagamento, status, etc.
function buscarStatusConhecido(obj, listas, profundidade = 0) {
  if (!obj || typeof obj !== 'object' || profundidade > 6) return null;
  for (const valor of Object.values(obj)) {
    if (typeof valor === 'string') {
      const normalizado = valor.trim().toLowerCase();
      for (const lista of listas) {
        if (lista.includes(normalizado)) return normalizado;
      }
    }
  }
  for (const valor of Object.values(obj)) {
    if (valor && typeof valor === 'object') {
      const achado = buscarStatusConhecido(valor, listas, profundidade + 1);
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

    const statusEncontrado = buscarStatusConhecido(body, [STATUS_PAGO, STATUS_CANCELADO, STATUS_AFTER_PAY]);
    const pago = STATUS_PAGO.includes(statusEncontrado);
    const cancelado = STATUS_CANCELADO.includes(statusEncontrado);
    const afterPaySemPagar = STATUS_AFTER_PAY.includes(statusEncontrado) && !pago;

    // Regra da Skale (Pay After Delivery):
    // - pedido criado com pagamento "After Pay" e ainda nao pago -> vira AGENDAMENTO
    //   (fica atribuido por telefone, mas NAO dispara Purchase pro Meta ainda)
    // - quando o pagamento confirma depois -> vira VENDA de verdade e dispara Purchase
    let status;
    if (pago) {
      status = 'aprovada';
    } else if (cancelado) {
      status = 'cancelada';
    } else if (afterPaySemPagar) {
      status = 'agendamento';
    } else {
      status = statusEncontrado || 'desconhecido';
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
