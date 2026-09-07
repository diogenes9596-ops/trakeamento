const axios = require('axios');
const pool = require('../db');
const { obterCotacaoParaData } = require('./fxService');

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Testa se o token + conta de anuncio sao validos antes de salvar no banco.
// Ja retorna o nome e a moeda da conta (pra popular a tela de confirmacao).
async function testarConexaoContaAnuncio(adAccountId, accessToken) {
  try {
    const url = `${GRAPH_BASE}/${adAccountId}`;
    const { data } = await axios.get(url, {
      params: { fields: 'name,account_status,currency', access_token: accessToken },
    });
    return { ok: true, dados: data };
  } catch (err) {
    const mensagem = err.response?.data?.error?.message || err.message;
    return { ok: false, mensagem };
  }
}

// Resolve nome + moeda de varias contas de uma vez, a partir de um BM ID + token
// (usado no fluxo "Importar BM": cola o token e a lista de IDs, confirma o que
// achou, e so entao salva no banco)
async function resolverContasEmLote(accountIds, accessToken) {
  const resultados = [];
  for (const idBruto of accountIds) {
    const id = idBruto.trim();
    if (!id) continue;
    const contaFormatada = id.startsWith('act_') ? id : `act_${id}`;
    const teste = await testarConexaoContaAnuncio(contaFormatada, accessToken);
    resultados.push({
      ad_account_id: contaFormatada,
      ok: teste.ok,
      nome: teste.dados?.name || null,
      moeda: teste.dados?.currency || null,
      erro: teste.ok ? null : teste.mensagem,
    });
  }
  return resultados;
}

// Puxa o gasto por anuncio (nivel "ad") de uma conta, num intervalo de datas.
// dataInicio e dataFim no formato 'YYYY-MM-DD'.
async function buscarGastoPorAnuncio(adAccountId, accessToken, dataInicio, dataFim) {
  const url = `${GRAPH_BASE}/${adAccountId}/insights`;
  const params = {
    level: 'ad',
    fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks',
    time_range: JSON.stringify({ since: dataInicio, until: dataFim }),
    time_increment: 1, // um registro por dia
    limit: 500,
    access_token: accessToken,
  };

  let resultados = [];
  let proximaUrl = url;
  let proximosParams = params;

  while (proximaUrl) {
    const { data } = await axios.get(proximaUrl, { params: proximosParams });
    resultados = resultados.concat(data.data || []);

    if (data.paging && data.paging.next) {
      proximaUrl = data.paging.next;
      proximosParams = undefined; // a URL "next" ja vem com todos os parametros
    } else {
      proximaUrl = null;
    }
  }

  return resultados;
}

// Salva (ou atualiza) os registros de gasto no banco, convertendo pra BRL
// quando a conta de anuncio for em outra moeda (USD, por ex).
async function salvarGastoDiario(adAccountDbId, moedaOriginal, registros) {
  for (const r of registros) {
    const gastoOriginal = parseFloat(r.spend || 0);
    let gastoBrl = gastoOriginal;

    if (moedaOriginal && moedaOriginal !== 'BRL') {
      const cotacao = await obterCotacaoParaData(r.date_start);
      gastoBrl = gastoOriginal * cotacao;
    }

    await pool.query(
      `INSERT INTO ad_spend_daily
        (ad_account_id, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, data,
         gasto_moeda_original, moeda_original, gasto, impressoes, cliques)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ad_id, data)
       DO UPDATE SET gasto = EXCLUDED.gasto,
                     gasto_moeda_original = EXCLUDED.gasto_moeda_original,
                     impressoes = EXCLUDED.impressoes,
                     cliques = EXCLUDED.cliques,
                     ad_name = EXCLUDED.ad_name`,
      [
        adAccountDbId,
        r.ad_id,
        r.ad_name || null,
        r.adset_id || null,
        r.adset_name || null,
        r.campaign_id || null,
        r.campaign_name || null,
        r.date_start,
        gastoOriginal,
        moedaOriginal || 'BRL',
        gastoBrl,
        parseInt(r.impressions || 0, 10),
        parseInt(r.clicks || 0, 10),
      ]
    );
  }
}

// Roda a sincronizacao para todas as contas ativas, dos ultimos N dias
// (isso cobre re-processamentos que a Meta faz nos numeros de atribuicao)
async function sincronizarTodasContas(diasParaTras = 3) {
  const contas = await pool.query('SELECT * FROM ad_accounts WHERE ativo = TRUE');

  const hoje = new Date();
  const dataFim = hoje.toISOString().slice(0, 10);
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - diasParaTras);
  const dataInicio = inicio.toISOString().slice(0, 10);

  const relatorio = [];

  for (const conta of contas.rows) {
    try {
      const registros = await buscarGastoPorAnuncio(conta.ad_account_id, conta.access_token, dataInicio, dataFim);
      await salvarGastoDiario(conta.id, conta.moeda, registros);
      relatorio.push({ conta: conta.nome, registros: registros.length, ok: true });
    } catch (err) {
      const mensagem = err.response?.data?.error?.message || err.message;
      console.error(`Erro ao sincronizar conta ${conta.nome}:`, mensagem);
      relatorio.push({ conta: conta.nome, ok: false, erro: mensagem });
    }
  }

  return relatorio;
}

module.exports = {
  testarConexaoContaAnuncio,
  resolverContasEmLote,
  buscarGastoPorAnuncio,
  salvarGastoDiario,
  sincronizarTodasContas,
};
