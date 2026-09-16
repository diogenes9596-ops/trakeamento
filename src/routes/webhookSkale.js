const express = require('express');
const pool = require('../db');
const { obterSecret } = require('../services/webhookSecretsService');
const { atribuirVendasPendentes } = require('../services/attributionService');
const { normalizarTelefoneBR } = require('../utils/telefone');
const { instanteDeBrasilia } = require('../utils/datas');

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
// sinonimos -- usado sÃ³ pra cancelamento, que pode vir com varias palavras
// diferentes e em campos menos previsÃ­veis. NUNCA usar isso pra detectar
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

// Extrai a data REAL do pagamento do payload da Skale (campos
// transaction.paid_at_data + paid_at_hora, ou transaction.paid_at como
// fallback). So preenchido quando o pagamento ja confirmou -- e exatamente
// o que a Skale usa como "data_pagamento" nos relatorios dela, entao usar
// isso aqui garante que "hoje" signifique a mesma coisa nos dois sistemas.
function extrairDataPagamento(body) {
  const t = body?.transaction || {};
  if (t.paid_at_data) {
    if (t.paid_at_hora) {
      const d = new Date(`${t.paid_at_data}T${t.paid_at_hora}-03:00`);
      if (!isNaN(d.getTime())) return d;
    }
    // paid_at_hora ausente -- usar meia-noite quebra a ATRIBUICAO por
    // telefone: o lead que gerou a venda quase sempre chega DEPOIS da
    // meia-noite mas ANTES do horario real do pagamento (ex: lead as 10h,
    // pagamento as 13h) -- forcar meia-noite fazia o sistema achar que o
    // lead "veio depois" da venda e nunca atribuir. Usamos updated_at (que
    // tem hora completa) quando for do mesmo dia do pagamento -- e o
    // proprio evento que confirmou o "Pago", entao e a hora real mais
    // proxima que temos.
    if (t.updated_at_data === t.paid_at_data && t.updated_at_hora) {
      const d = new Date(`${t.updated_at_data}T${t.updated_at_hora}-03:00`);
      if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(`${t.paid_at_data}T00:00:00-03:00`);
    if (!isNaN(d.getTime())) return d;
  }
  if (t.paid_at) {
    // Sem fuso no texto, "2026-09-16 22:30:00" era lido no fuso do servidor
    // (UTC no Railway) -- 3h de diferenca, podendo cair no dia seguinte.
    const d = instanteDeBrasilia(t.paid_at);
    if (d) return d;
  }
  return null;
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
    // Campos confirmados com payloads reais da Skale em 16/09/2026 -- leitura
    // direta. Antes cada campo era "o primeiro que existisse" numa lista de
    // caminhos possiveis, o que podia pegar o campo errado (ex: um id que nao
    // fosse o transaction_id). Todas as vendas ja gravadas usam ven_XXXXXX
    // (conferido no banco de producao), entao a troca nao gera duplicata.
    const idExterno = body?.transaction_id;
    if (!idExterno) {
      console.warn('Webhook Skale sem transaction_id. Payload:', JSON.stringify(body).slice(0, 1000));
      return;
    }
    const idExternoTexto = String(idExterno);

    const telefone = normalizarTelefoneBR(body?.customer?.phone);

    const email = body?.customer?.email || null;
    const nomeCliente = body?.customer?.name || null;
    const produto = body?.product?.name || null; // nome do kit, ex: "6 MESES"

    // transaction.total_price vem SEMPRE em centavos -- divide por 100 sempre.
    // (A regra antiga so dividia acima de 10000, o que gravava um produto de
    // R$ 97,00 como R$ 9.700,00.) Evento sem o campo (ex: atualizacao tardia
    // de rastreio) deixa valor = null e a venda mantem o valor que ja tinha.
    const totalPrice = parseFloat(body?.transaction?.total_price);
    const valor = Number.isFinite(totalPrice) ? totalPrice / 100 : null;
    if (valor === null) {
      console.log(`Webhook Skale ${idExternoTexto} sem transaction.total_price -- valor salvo mantido.`);
    }

    // Campos ESPECIFICOS (nao busca cega) -- confirmados com payloads reais
    // da Skale: transaction.payment_status Ã© o status financeiro de verdade
    // ("Pago", "Aguardando Pagamento", "After Pay", "Recusado"...), e
    // transaction.payment_method Ã© a FORMA escolhida pelo cliente
    // ("Antecipada" = paga na hora, "After Pay" = paga na entrega).
    // skaletracking.status_pagamento Ã© usado como reforÃ§o/fallback.
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
    //   telefone; nenhum status dispara evento pro Meta -- ver fim do handler)
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

    // Data que vai contar como "recebido_em" (o "hoje" da nossa plataforma):
    // - se o pedido ACABOU de ser pago, usa a data REAL do pagamento que a
    //   Skale manda -- assim nosso "hoje" bate com o "hoje" da Skale, que
    //   tambem conta por data de pagamento.
    // - em qualquer outro caso (agendamento, pendente, cancelada...) nao
    //   mexe na data -- continua sendo quando o pedido/evento chegou aqui.
    const dataPagamento = status === 'aprovada' ? extrairDataPagamento(body) : null;

    await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto, recebido_em)
       VALUES ('skale', $1, $2, $3, $4, $5, COALESCE($6::numeric, 0), $7, $8, COALESCE($9::timestamptz, NOW()))
       ON CONFLICT (plataforma, id_externo)
       DO UPDATE SET status = EXCLUDED.status, valor = COALESCE($6::numeric, sales.valor), atribuido_em = NULL,
                     payload_bruto = EXCLUDED.payload_bruto,
                     recebido_em = COALESCE($9::timestamptz, sales.recebido_em)`,
      [idExternoTexto, status, telefone, email, nomeCliente, valor, produto, JSON.stringify(body), dataPagamento]
    );

    await atribuirVendasPendentes();

    // Envio pro Meta CAPI DESLIGADO de vez a pedido do usuario em 16/09/2026,
    // voltando a regra original de "nunca enviar automatico" -- mesma regra
    // do webhook da Payt e do DataCrazy. Ficou ligado aqui so de 15/09 a
    // 16/09/2026. Esse webhook so registra a venda na plataforma; envio pro
    // Meta continua disponivel, manual, via /api/eventos-manuais.
  } catch (err) {
    console.error('Erro ao processar webhook da Skale:', err);
  }
});

module.exports = router;
