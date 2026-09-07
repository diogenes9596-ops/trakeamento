const express = require('express');
const pool = require('../db');
const { sincronizarTodasContas } = require('../services/metaAdsService');
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
      `SELECT COALESCE(SUM(gasto), 0) as total FROM ad_spend_daily WHERE data BETWEEN $1 AND $2`,
      [inicio, fim]
    );
    const vendas = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as total
       FROM sales WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const gastoTotal = parseFloat(gasto.rows[0].total);
    const faturamentoTotal = parseFloat(vendas.rows[0].total);

    res.json({
      periodo: { inicio, fim },
      gasto_total: gastoTotal,
      faturamento_total: faturamentoTotal,
      qtd_vendas: parseInt(vendas.rows[0].qtd, 10),
      roas_geral: gastoTotal > 0 ? Math.round((faturamentoTotal / gastoTotal) * 100) / 100 : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar totais' });
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
// niveis, só muda o agrupamento)
router.get('/campanhas', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);
  const nivel = ['campanhas', 'conjuntos', 'anuncios'].includes(req.query.nivel) ? req.query.nivel : 'campanhas';

  const colunaId = { campanhas: 'campaign_id', conjuntos: 'adset_id', anuncios: 'ad_id' }[nivel];
  const colunaNome = { campanhas: 'campaign_name', conjuntos: 'adset_name', anuncios: 'ad_name' }[nivel];

  try {
    const result = await pool.query(
      `WITH gasto AS (
         SELECT ${colunaId} as id, MAX(${colunaNome}) as nome, SUM(gasto) as gasto_total,
                SUM(impressoes) as impressoes, SUM(cliques) as cliques
         FROM ad_spend_daily
         WHERE data BETWEEN $1 AND $2 AND ${colunaId} IS NOT NULL
         GROUP BY ${colunaId}
       ),
       leads_ AS (
         SELECT ad_id, COUNT(*) as qtd FROM leads
         WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day') AND ad_id IS NOT NULL
         GROUP BY ad_id
       ),
       vendas AS (
         SELECT ad_id, COUNT(*) FILTER (WHERE status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(valor) FILTER (WHERE status = 'aprovada'), 0) as faturamento,
                COUNT(*) FILTER (WHERE status = 'agendamento') as qtd_agendamentos
         FROM sales
         WHERE ad_id IS NOT NULL AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY ad_id
       )
       SELECT g.id, g.nome, g.gasto_total, g.impressoes, g.cliques,
              COALESCE(l.qtd, 0) as leads,
              COALESCE(v.qtd_vendas, 0) as vendas,
              COALESCE(v.faturamento, 0) as faturamento,
              COALESCE(v.qtd_agendamentos, 0) as agendamentos
       FROM gasto g
       LEFT JOIN leads_ l ON l.ad_id = g.id AND $3 = 'anuncios'
       LEFT JOIN vendas v ON v.ad_id = g.id AND $3 = 'anuncios'
       ORDER BY g.gasto_total DESC`,
      [inicio, fim, nivel]
    );

    res.json({ nivel, linhas: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar tabela de campanhas' });
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
         SELECT ad_name as criativo, SUM(gasto) as investido, COUNT(DISTINCT ad_id) as qtd_anuncios
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
              CASE WHEN COALESCE(v.qtd_vendas,0) > 0 THEN ROUND((g.investido / v.qtd_vendas)::numeric, 2) ELSE NULL END as cpa
       FROM gasto g
       LEFT JOIN leads_ l ON l.criativo = g.criativo
       LEFT JOIN vendas v ON v.criativo = g.criativo
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
      `SELECT l.*, s.campaign_name, s.adset_name, s.ad_name
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT campaign_name, adset_name, ad_name FROM ad_spend_daily
         WHERE ad_id = l.ad_id ORDER BY data DESC LIMIT 1
       ) s ON TRUE
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
