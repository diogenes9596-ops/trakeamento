const express = require('express');
const pool = require('../db');
const { sincronizarTodasContas, atualizarStatus } = require('../services/metaAdsService');
const { atribuirVendasPendentes } = require('../services/attributionService');

const router = express.Router();

// Visao principal: por anuncio/criativo, gasto no periodo x vendas atribuidas
router.get('/resumo-por-anuncio', async (req, res) => {
  const { data_inicio, data_fim } = req.query;
  const inicio = data_inicio || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const fim = data_fim || new Date().toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `WITH gasto AS (
         SELECT ad_id, MAX(ad_name) as ad_name, MAX(campaign_name) as campaign_name,
                SUM(gasto) as gasto_total
         FROM ad_spend_daily
         WHERE data BETWEEN $1 AND $2
         GROUP BY ad_id
       ),
       vendas AS (
         SELECT ad_id, COUNT(*) FILTER (WHERE status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(valor) FILTER (WHERE status = 'aprovada'), 0) as faturamento
         FROM sales
         WHERE ad_id IS NOT NULL
           AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY ad_id
       )
       SELECT
         COALESCE(g.ad_id, v.ad_id) as ad_id,
         g.ad_name,
         g.campaign_name,
         COALESCE(g.gasto_total, 0) as gasto_total,
         COALESCE(v.qtd_vendas, 0) as qtd_vendas,
         COALESCE(v.faturamento, 0) as faturamento,
         CASE WHEN COALESCE(g.gasto_total, 0) > 0
              THEN ROUND((COALESCE(v.faturamento, 0) / g.gasto_total)::numeric, 2)
              ELSE NULL END as roas,
         CASE WHEN COALESCE(v.qtd_vendas, 0) > 0
              THEN ROUND((COALESCE(g.gasto_total, 0) / v.qtd_vendas)::numeric, 2)
              ELSE NULL END as cpa
       FROM gasto g
       FULL OUTER JOIN vendas v ON g.ad_id = v.ad_id
       ORDER BY faturamento DESC NULLS LAST, gasto_total DESC`,
      [inicio, fim]
    );

    const vendasSemAtribuicao = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as valor
       FROM sales
       WHERE ad_id IS NULL AND status = 'aprovada'
         AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    res.json({
      periodo: { inicio, fim },
      por_anuncio: result.rows,
      sem_atribuicao: vendasSemAtribuicao.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar resumo' });
  }
});

// Totais gerais do periodo (cards do topo do dashboard)
router.get('/totais', async (req, res) => {
  const { data_inicio, data_fim } = req.query;
  const inicio = data_inicio || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const fim = data_fim || new Date().toISOString().slice(0, 10);

  try {
    const gasto = await pool.query(
      `SELECT COALESCE(SUM(gasto), 0) as total,
              COALESCE(SUM(gasto) FILTER (WHERE moeda_original = 'BRL'), 0) as total_brl
       FROM ad_spend_daily WHERE data BETWEEN $1 AND $2`,
      [inicio, fim]
    );
    const vendas = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as total
       FROM sales WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    // Imposto de 12,5% se aplica apenas sobre o gasto de contas em BRL
    // (contas em USD nao somam esse imposto - regra definida em Configuracoes > Cotacao do dolar)
    const gastoTotal = parseFloat(gasto.rows[0].total);
    const gastoBrl = parseFloat(gasto.rows[0].total_brl);
    const imposto = Math.round(gastoBrl * 0.125 * 100) / 100;
    const investidoTotal = gastoTotal + imposto;

    const faturamentoTotal = parseFloat(vendas.rows[0].total);

    res.json({
      periodo: { inicio, fim },
      gasto_total: gastoTotal,
      imposto,
      investido_total: investidoTotal,
      faturamento_total: faturamentoTotal,
      qtd_vendas: parseInt(vendas.rows[0].qtd, 10),
      roas_geral: investidoTotal > 0 ? Math.round((faturamentoTotal / investidoTotal) * 100) / 100 : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar totais' });
  }
});

// Transacoes de gateway (boletos/pix gerados, cartoes recusados) - contadas a
// partir do metodo de pagamento presente no payload bruto de cada venda
router.get('/gateway', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE payload_bruto->'transaction'->>'payment_method' ILIKE '%boleto%'
                             OR payload_bruto->>'payment_method' ILIKE '%boleto%') as boletos,
         COUNT(*) FILTER (WHERE payload_bruto->'transaction'->>'payment_method' ILIKE '%pix%'
                             OR payload_bruto->>'payment_method' ILIKE '%pix%') as pix,
         COUNT(*) FILTER (WHERE status = 'recusada') as recusados
       FROM sales
       WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );
    const row = result.rows[0];
    res.json({
      boletos_gerados: parseInt(row.boletos, 10),
      pix_gerados: parseInt(row.pix, 10),
      cartoes_recusados: parseInt(row.recusados, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar dados de gateway' });
  }
});

// Dispara manualmente a sincronizacao de gasto + atribuicao (util pra testar,
// alem do cron automatico configurado em src/jobs/pullAdSpend.js)
router.post('/sincronizar-agora', async (req, res) => {
  try {
    const relatorioGasto = await sincronizarTodasContas();
    const relatorioAtribuicao = await atribuirVendasPendentes();
    res.json({ gasto: relatorioGasto, atribuicao: relatorioAtribuicao });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao sincronizar' });
  }
});

function periodoOuPadrao(req) {
  const inicio = req.query.data_inicio || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const fim = req.query.data_fim || new Date().toISOString().slice(0, 10);
  return { inicio, fim };
}

// Funil de conversao + transacoes de gateway + agendamentos, pra tela Overview
router.get('/funil', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  try {
    const leads = await pool.query(
      `SELECT COUNT(*) as qtd FROM leads WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );
    const gasto = await pool.query(
      `SELECT COALESCE(SUM(gasto), 0) as total FROM ad_spend_daily WHERE data BETWEEN $1 AND $2`,
      [inicio, fim]
    );
    const vendas = await pool.query(
      `SELECT COUNT(*) as qtd FROM sales WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );
    const agendamentos = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as valor FROM sales
       WHERE status = 'agendamento' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const qtdLeads = parseInt(leads.rows[0].qtd, 10);
    const gastoTotal = parseFloat(gasto.rows[0].total);
    const qtdVendas = parseInt(vendas.rows[0].qtd, 10);

    res.json({
      leads: qtdLeads,
      cpl: qtdLeads > 0 ? Math.round((gastoTotal / qtdLeads) * 100) / 100 : null,
      vendas: qtdVendas,
      cpa: qtdVendas > 0 ? Math.round((gastoTotal / qtdVendas) * 100) / 100 : null,
      agendamentos: parseInt(agendamentos.rows[0].qtd, 10),
      faturamento_agendado: parseFloat(agendamentos.rows[0].valor),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar funil' });
  }
});

// Tabela de Campanhas / Conjuntos / Anuncios (a mesma consulta serve pros 3
// niveis, só muda o agrupamento). Agora cruza com a estrutura real do Meta
// (nome, status, orcamento) sincronizada em meta_campaigns/meta_adsets/meta_ads.
router.get('/campanhas', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  const nivel = ['campanhas', 'conjuntos', 'anuncios'].includes(req.query.nivel) ? req.query.nivel : 'campanhas';
  const statusFiltro = ['todas', 'ativas', 'pausadas'].includes(req.query.status) ? req.query.status : 'todas';
  const busca = (req.query.busca || '').trim();

  const tabela = { campanhas: 'meta_campaigns', conjuntos: 'meta_adsets', anuncios: 'meta_ads' }[nivel];
  const colunaGasto = { campanhas: 'campaign_id', conjuntos: 'adset_id', anuncios: 'ad_id' }[nivel];

  try {
    const condicoes = [];
    const params = [inicio, fim];

    if (statusFiltro === 'ativas') condicoes.push(`e.status = 'ACTIVE'`);
    if (statusFiltro === 'pausadas') condicoes.push(`e.status = 'PAUSED'`);
    if (busca) {
      params.push(`%${busca}%`);
      condicoes.push(`e.nome ILIKE $${params.length}`);
    }
    const whereExtra = condicoes.length ? `AND ${condicoes.join(' AND ')}` : '';

    const result = await pool.query(
      `WITH gasto AS (
         SELECT ${colunaGasto} as id, SUM(gasto) as gasto_total,
                SUM(impressoes) as impressoes, SUM(cliques) as cliques
         FROM ad_spend_daily
         WHERE data BETWEEN $1 AND $2 AND ${colunaGasto} IS NOT NULL
         GROUP BY ${colunaGasto}
       ),
       leads_ AS (
         SELECT ad_id, COUNT(*) as qtd FROM leads
         WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day') AND ad_id IS NOT NULL
         GROUP BY ad_id
       ),
       vendas AS (
         SELECT ad_id, COUNT(*) FILTER (WHERE status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(valor) FILTER (WHERE status = 'aprovada'), 0) as faturamento,
                COUNT(*) FILTER (WHERE status = 'agendamento') as qtd_agendamentos,
                COALESCE(SUM(valor) FILTER (WHERE status = 'agendamento'), 0) as faturamento_agendado
         FROM sales
         WHERE ad_id IS NOT NULL AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY ad_id
       )
       SELECT e.id, e.nome, e.status, e.orcamento_diario, e.lance, e.ad_account_id,
              COALESCE(g.gasto_total, 0) as gasto_total,
              COALESCE(g.impressoes, 0) as impressoes,
              COALESCE(g.cliques, 0) as cliques,
              COALESCE(l.qtd, 0) as leads,
              COALESCE(v.qtd_vendas, 0) as vendas,
              COALESCE(v.faturamento, 0) as faturamento,
              COALESCE(v.qtd_agendamentos, 0) as agendamentos,
              COALESCE(v.faturamento_agendado, 0) as faturamento_agendado
       FROM ${tabela} e
       LEFT JOIN gasto g ON g.id = e.id
       LEFT JOIN leads_ l ON l.ad_id = e.id AND '${nivel}' = 'anuncios'
       LEFT JOIN vendas v ON v.ad_id = e.id AND '${nivel}' = 'anuncios'
       WHERE 1=1 ${whereExtra}
       ORDER BY gasto_total DESC NULLS LAST`,
      params
    );

    res.json({ nivel, linhas: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar tabela de campanhas' });
  }
});

// Pausar / ativar uma campanha, conjunto ou anuncio direto no Meta
router.patch('/campanhas/:nivel/:id/status', async (req, res) => {
  const { nivel, id } = req.params;
  const { ativo } = req.body;

  if (!['campanhas', 'conjuntos', 'anuncios'].includes(nivel)) {
    return res.status(400).json({ erro: 'Nivel invalido' });
  }

  try {
    const tabela = { campanhas: 'meta_campaigns', conjuntos: 'meta_adsets', anuncios: 'meta_ads' }[nivel];
    const registro = await pool.query(`SELECT e.*, a.access_token FROM ${tabela} e JOIN ad_accounts a ON a.id = e.ad_account_id WHERE e.id = $1`, [id]);

    if (registro.rows.length === 0) {
      return res.status(404).json({ erro: 'Nao encontrado' });
    }

    const novoStatus = ativo ? 'ACTIVE' : 'PAUSED';
    await atualizarStatus(nivel, id, novoStatus, registro.rows[0].access_token);

    res.json({ sucesso: true, status: novoStatus });
  } catch (err) {
    const mensagem = err.response?.data?.error?.message || err.message;
    console.error('Erro ao atualizar status no Meta:', mensagem);
    res.status(500).json({ erro: `Nao consegui atualizar no Meta: ${mensagem}` });
  }
});

// Ranking de criativos — agrupa por nome do anuncio (na pratica, o nome do
// criativo), somando entre contas/campanhas diferentes que usam o mesmo nome
router.get('/criativos', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  const ordenarPor = ['vendas', 'roas', 'faturamento', 'lucro', 'investido', 'leads', 'cpa'].includes(req.query.ordenar)
    ? req.query.ordenar
    : 'vendas';

  try {
    const result = await pool.query(
      `WITH gasto AS (
         SELECT ad_name as criativo, SUM(gasto) as investido, COUNT(DISTINCT ad_id) as qtd_anuncios,
                MIN(ad_id) as exemplo_ad_id, MIN(ad_account_id) as exemplo_conta_id
         FROM ad_spend_daily
         WHERE data BETWEEN $1 AND $2 AND ad_name IS NOT NULL
         GROUP BY ad_name
       ),
       leads_ AS (
         SELECT s.ad_name as criativo, COUNT(l.*) as qtd
         FROM leads l
         JOIN ad_spend_daily s ON s.ad_id = l.ad_id
         WHERE l.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY s.ad_name
       ),
       vendas AS (
         SELECT s2.ad_name as criativo,
                COUNT(*) FILTER (WHERE sa.status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(sa.valor) FILTER (WHERE sa.status = 'aprovada'), 0) as faturamento
         FROM sales sa
         JOIN ad_spend_daily s2 ON s2.ad_id = sa.ad_id
         WHERE sa.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY s2.ad_name
       )
       SELECT g.criativo, g.investido, g.qtd_anuncios,
              COALESCE(l.qtd, 0) as leads,
              COALESCE(v.qtd_vendas, 0) as vendas,
              COALESCE(v.faturamento, 0) as faturamento,
              COALESCE(v.faturamento, 0) - g.investido as lucro,
              CASE WHEN g.investido > 0 THEN ROUND((COALESCE(v.faturamento,0) / g.investido)::numeric, 2) ELSE NULL END as roas,
              CASE WHEN COALESCE(v.qtd_vendas,0) > 0 THEN ROUND((g.investido / v.qtd_vendas)::numeric, 2) ELSE NULL END as cpa,
              g.exemplo_ad_id, acc.ad_account_id as meta_account_id
       FROM gasto g
       LEFT JOIN leads_ l ON l.criativo = g.criativo
       LEFT JOIN vendas v ON v.criativo = g.criativo
       LEFT JOIN ad_accounts acc ON acc.id = g.exemplo_conta_id
       ORDER BY ${ordenarPor === 'roas' ? 'roas' : ordenarPor} DESC NULLS LAST
       LIMIT 100`,
      [inicio, fim]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar ranking de criativos' });
  }
});

// Lista de leads recebidos (aba "Leads")
router.get('/leads', async (req, res) => {
  const busca = req.query.busca || '';
  try {
    const result = await pool.query(
      `SELECT l.*, s.campaign_name, s.adset_name, s.ad_name, acc.ad_account_id as meta_account_id
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT campaign_name, adset_name, ad_name, ad_account_id FROM ad_spend_daily
         WHERE ad_id = l.ad_id ORDER BY data DESC LIMIT 1
       ) s ON TRUE
       LEFT JOIN ad_accounts acc ON acc.id = s.ad_account_id
       WHERE ($1 = '' OR l.telefone LIKE '%' || $1 || '%')
       ORDER BY l.recebido_em DESC
       LIMIT 200`,
      [busca.replace(/\D/g, '')]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar leads' });
  }
});

// Lista de vendas (aba "Vendas"), com filtro por origem e status
router.get('/vendas', async (req, res) => {
  const origem = req.query.origem && req.query.origem !== 'todas' ? req.query.origem : null;
  const status = req.query.status && req.query.status !== 'todos' ? req.query.status : null;

  try {
    const result = await pool.query(
      `SELECT sa.*, s.campaign_name, s.adset_name, s.ad_name
       FROM sales sa
       LEFT JOIN LATERAL (
         SELECT campaign_name, adset_name, ad_name FROM ad_spend_daily
         WHERE ad_id = sa.ad_id ORDER BY data DESC LIMIT 1
       ) s ON TRUE
       WHERE ($1::text IS NULL OR sa.plataforma = $1)
         AND ($2::text IS NULL OR sa.status = $2)
       ORDER BY sa.recebido_em DESC
       LIMIT 200`,
      [origem, status]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar vendas' });
  }
});

// Log de eventos enviados pro CAPI (aba "Eventos")
router.get('/eventos', async (req, res) => {
  const tipo = req.query.tipo && req.query.tipo !== 'todos' ? req.query.tipo : null;
  try {
    const result = await pool.query(
      `SELECT * FROM eventos_capi WHERE ($1::text IS NULL OR evento = $1) ORDER BY enviado_em DESC LIMIT 200`,
      [tipo]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar eventos' });
  }
});

// Serie diaria de gasto x faturamento, pro grafico "Evolucao no periodo"
router.get('/serie-diaria', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  try {
    const result = await pool.query(
      `WITH dias AS (
         SELECT generate_series($1::date, $2::date, '1 day')::date as dia
       ),
       gasto AS (
         SELECT data, SUM(gasto) as total FROM ad_spend_daily WHERE data BETWEEN $1 AND $2 GROUP BY data
       ),
       vendas AS (
         SELECT recebido_em::date as dia, SUM(valor) as total FROM sales
         WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY recebido_em::date
       )
       SELECT d.dia, COALESCE(g.total, 0) as gasto, COALESCE(v.total, 0) as faturamento
       FROM dias d
       LEFT JOIN gasto g ON g.data = d.dia
       LEFT JOIN vendas v ON v.dia = d.dia
       ORDER BY d.dia`,
      [inicio, fim]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar serie diaria' });
  }
});

module.exports = router;
