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
  const contaId = req.query.conta_id && req.query.conta_id !== 'todas' ? parseInt(req.query.conta_id, 10) : null;
  // "Descer de nivel" com linhas marcadas (ex: marcou 2 campanhas e foi em
  // Conjuntos) manda esses IDs aqui, pra so trazer os conjuntos/anuncios
  // daquelas campanhas -- sem isso, a aba Conjuntos sempre mostrava TUDO,
  // de qualquer campanha, mesmo com uma selecionada.
  const paiNivel = ['campanhas', 'conjuntos'].includes(req.query.pai_nivel) ? req.query.pai_nivel : null;
  const paiIds = (req.query.pai_ids || '').split(',').map(s => s.trim()).filter(Boolean);

  const tabela = { campanhas: 'meta_campaigns', conjuntos: 'meta_adsets', anuncios: 'meta_ads' }[nivel];
  const colunaGasto = { campanhas: 'campaign_id', conjuntos: 'adset_id', anuncios: 'ad_id' }[nivel];
  const colunaMapa = { campanhas: 'campaign_id', conjuntos: 'adset_id', anuncios: 'id' }[nivel];

  try {
    const condicoes = [];
    const params = [inicio, fim];

    if (statusFiltro === 'ativas') condicoes.push(`e.status = 'ACTIVE'`);
    if (statusFiltro === 'pausadas') condicoes.push(`e.status = 'PAUSED'`);
    if (busca) {
      params.push(`%${busca}%`);
      condicoes.push(`e.nome ILIKE $${params.length}`);
    }
    if (contaId) {
      params.push(contaId);
      condicoes.push(`e.ad_account_id = $${params.length}`);
    }
    // 'campanhas' nao tem nivel pai, entao so filtramos aqui pra conjuntos/anuncios
    let colunaFiltroPai = null;
    if (paiNivel === 'campanhas' && (nivel === 'conjuntos' || nivel === 'anuncios')) {
      colunaFiltroPai = 'campaign_id';
    } else if (paiNivel === 'conjuntos' && nivel === 'anuncios') {
      colunaFiltroPai = 'adset_id';
    }
    if (colunaFiltroPai && paiIds.length > 0) {
      params.push(paiIds);
      condicoes.push(`e.${colunaFiltroPai} = ANY($${params.length}::varchar[])`);
    }
    const whereExtra = condicoes.length ? `AND ${condicoes.join(' AND ')}` : '';

    const result = await pool.query(
      `WITH mapa AS (
         SELECT id as ad_id, ${colunaMapa} as grupo_id FROM meta_ads WHERE ${colunaMapa} IS NOT NULL
       ),
       gasto AS (
         SELECT ${colunaGasto} as id, SUM(gasto) as gasto_total,
                SUM(impressoes) as impressoes, SUM(cliques) as cliques
         FROM ad_spend_daily
         WHERE data BETWEEN $1 AND $2 AND ${colunaGasto} IS NOT NULL
         GROUP BY ${colunaGasto}
       ),
       leads_ AS (
         SELECT m.grupo_id as id, COUNT(*) as qtd
         FROM leads l JOIN mapa m ON m.ad_id = l.ad_id
         WHERE l.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day') AND l.ad_id IS NOT NULL
         GROUP BY m.grupo_id
       ),
       vendas AS (
         SELECT m.grupo_id as id,
                COUNT(*) FILTER (WHERE sa.status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(sa.valor) FILTER (WHERE sa.status = 'aprovada'), 0) as faturamento,
                COUNT(*) FILTER (WHERE sa.status = 'agendamento') as qtd_agendamentos,
                COALESCE(SUM(sa.valor) FILTER (WHERE sa.status = 'agendamento'), 0) as faturamento_agendado,
                COUNT(*) FILTER (WHERE sa.payload_bruto->'transaction'->>'payment_method' ILIKE '%boleto%'
                                    OR sa.payload_bruto->>'payment_method' ILIKE '%boleto%') as boletos,
                COUNT(*) FILTER (WHERE sa.payload_bruto->'transaction'->>'payment_method' ILIKE '%pix%'
                                    OR sa.payload_bruto->>'payment_method' ILIKE '%pix%') as pix,
                COUNT(*) FILTER (WHERE sa.status = 'recusada') as recusados
         FROM sales sa JOIN mapa m ON m.ad_id = sa.ad_id
         WHERE sa.ad_id IS NOT NULL AND sa.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY m.grupo_id
       )
       SELECT e.id, e.nome, e.status, e.orcamento_diario, e.lance, e.ad_account_id,
              acc.nome as conta,
              ${nivel === 'anuncios' ? 'e.post_url, e.thumbnail_url,' : 'NULL as post_url, NULL as thumbnail_url,'}
              COALESCE(g.gasto_total, 0) as gasto_total,
              COALESCE(g.impressoes, 0) as impressoes,
              COALESCE(g.cliques, 0) as cliques,
              COALESCE(l.qtd, 0) as leads,
              COALESCE(v.qtd_vendas, 0) as vendas,
              COALESCE(v.faturamento, 0) as faturamento,
              COALESCE(v.qtd_agendamentos, 0) as agendamentos,
              COALESCE(v.faturamento_agendado, 0) as faturamento_agendado,
              COALESCE(v.boletos, 0) as boletos,
              COALESCE(v.pix, 0) as pix,
              COALESCE(v.recusados, 0) as recusados
       FROM ${tabela} e
       LEFT JOIN gasto g ON g.id = e.id
       LEFT JOIN leads_ l ON l.id = e.id
       LEFT JOIN vendas v ON v.id = e.id
       LEFT JOIN ad_accounts acc ON acc.id = e.ad_account_id
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
  const busca = (req.query.busca || '').trim();
  const contaId = req.query.conta_id && req.query.conta_id !== 'todas' ? parseInt(req.query.conta_id, 10) : null;

  try {
    const params = [inicio, fim];
    const condicoes = [];
    if (busca) {
      params.push(`%${busca}%`);
      condicoes.push(`ma.nome ILIKE $${params.length}`);
    }
    if (contaId) {
      params.push(contaId);
      condicoes.push(`ma.ad_account_id = $${params.length}`);
    }
    const whereExtra = condicoes.length ? `AND ${condicoes.join(' AND ')}` : '';

    // Usamos meta_ads como fonte da lista de criativos (nao so quem gastou no
    // periodo) -- assim um criativo antigo que nao esta mais no ar, mas que
    // gerou uma venda atribuida, continua aparecendo no ranking.
    const result = await pool.query(
      `WITH gasto AS (
         SELECT ma.nome as criativo,
                COALESCE(SUM(asd.gasto), 0) as investido,
                COUNT(DISTINCT ma.id) as qtd_anuncios,
                COUNT(DISTINCT ma.id) FILTER (WHERE ma.status = 'ACTIVE') as qtd_ativos,
                COUNT(DISTINCT ma.campaign_id) as qtd_campanhas,
                COUNT(DISTINCT ma.ad_account_id) as qtd_contas,
                (array_agg(ma.thumbnail_url) FILTER (WHERE ma.thumbnail_url IS NOT NULL))[1] as thumbnail_url,
                (array_agg(ma.post_url) FILTER (WHERE ma.post_url IS NOT NULL))[1] as post_url
         FROM meta_ads ma
         LEFT JOIN ad_spend_daily asd ON asd.ad_id = ma.id AND asd.data BETWEEN $1 AND $2
         WHERE ma.nome IS NOT NULL ${whereExtra}
         GROUP BY ma.nome
       ),
       leads_ AS (
         SELECT ma.nome as criativo, COUNT(*) as qtd
         FROM leads l JOIN meta_ads ma ON ma.id = l.ad_id
         WHERE l.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY ma.nome
       ),
       vendas AS (
         SELECT ma.nome as criativo,
                COUNT(*) FILTER (WHERE s.status = 'aprovada') as qtd_vendas,
                COALESCE(SUM(s.valor) FILTER (WHERE s.status = 'aprovada'), 0) as faturamento
         FROM sales s JOIN meta_ads ma ON ma.id = s.ad_id
         WHERE s.recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
         GROUP BY ma.nome
       )
       SELECT g.criativo, g.investido, g.qtd_anuncios, g.qtd_ativos, g.qtd_campanhas, g.qtd_contas,
              g.thumbnail_url, g.post_url,
              COALESCE(l.qtd, 0) as leads,
              COALESCE(v.qtd_vendas, 0) as vendas,
              COALESCE(v.faturamento, 0) as faturamento,
              COALESCE(v.faturamento, 0) - g.investido as lucro,
              CASE WHEN g.investido > 0 THEN ROUND((COALESCE(v.faturamento,0) / g.investido)::numeric, 2) ELSE NULL END as roas,
              CASE WHEN COALESCE(v.qtd_vendas,0) > 0 THEN ROUND((g.investido / v.qtd_vendas)::numeric, 2) ELSE NULL END as cpa,
              CASE WHEN COALESCE(l.qtd,0) > 0 THEN ROUND((g.investido / l.qtd)::numeric, 2) ELSE NULL END as cpl
       FROM gasto g
       LEFT JOIN leads_ l ON l.criativo = g.criativo
       LEFT JOIN vendas v ON v.criativo = g.criativo
       ORDER BY ${ordenarPor === 'cpa' ? 'cpa ASC NULLS LAST' : ordenarPor + ' DESC NULLS LAST'}
       LIMIT 100`,
      params
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
  const { inicio, fim } = periodoOuPadrao(req);
  try {
    const result = await pool.query(
      `SELECT l.*, s.campaign_name, s.adset_name, s.ad_name, ma.post_url, ma.thumbnail_url
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT campaign_name, adset_name, ad_name FROM ad_spend_daily
         WHERE ad_id = l.ad_id ORDER BY data DESC LIMIT 1
       ) s ON TRUE
       LEFT JOIN meta_ads ma ON ma.id = l.ad_id
       WHERE ($1 = '' OR l.telefone LIKE '%' || $1 || '%')
         AND l.recebido_em BETWEEN $2 AND ($3::date + INTERVAL '1 day')
       ORDER BY l.recebido_em DESC
       LIMIT 200`,
      [busca.replace(/\D/g, ''), inicio, fim]
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
  const busca = (req.query.busca || '').trim();
  const { inicio, fim } = periodoOuPadrao(req);

  try {
    const params = [origem, status, inicio, fim];
    let condBusca = '';
    if (busca) {
      params.push(`%${busca}%`);
      condBusca = `AND (sa.telefone ILIKE $${params.length} OR sa.email ILIKE $${params.length})`;
    }

    const result = await pool.query(
      `SELECT sa.*,
              mc.nome as campaign_name, mas.nome as adset_name, ma.nome as ad_name, ma.post_url,
              acc.nome as conta_nome, acc.ad_account_id as conta_meta_id
       FROM sales sa
       LEFT JOIN meta_ads ma ON ma.id = sa.ad_id
       LEFT JOIN meta_adsets mas ON mas.id = ma.adset_id
       LEFT JOIN meta_campaigns mc ON mc.id = ma.campaign_id
       LEFT JOIN ad_accounts acc ON acc.id = ma.ad_account_id
       WHERE ($1::text IS NULL OR sa.plataforma = $1)
         AND ($2::text IS NULL OR sa.status = $2)
         AND sa.recebido_em BETWEEN $3 AND ($4::date + INTERVAL '1 day')
         ${condBusca}
       ORDER BY sa.recebido_em DESC
       LIMIT 200`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar vendas' });
  }
});

// Remove uma venda (usado principalmente pra apagar lancamentos manuais errados)
router.delete('/vendas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao remover venda' });
  }
});

// Corrige manualmente o status (e opcionalmente a data, plataforma e
// id_externo) de uma venda -- usado pra reprocessar pedidos que ficaram
// classificados/datados errado por bug ja corrigido no webhook, e tambem
// pra converter lancamentos manuais (plataforma='manual') em registros
// "skale" de verdade (plataforma='skale' + id_externo='ven_XXXXX'), evitando
// que um webhook futuro do mesmo pedido crie uma venda duplicada.
const STATUS_VALIDOS = ['aprovada', 'cancelada', 'recusada', 'agendamento', 'desconhecido'];
router.patch('/vendas/:id/status', async (req, res) => {
  const { status, recebido_em, plataforma, id_externo } = req.body;
  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ erro: `status invalido, use um de: ${STATUS_VALIDOS.join(', ')}` });
  }
  try {
    const r = await pool.query(
      `UPDATE sales SET status = $1,
                        recebido_em = COALESCE($3::timestamptz, recebido_em),
                        plataforma = COALESCE($4, plataforma),
                        id_externo = COALESCE($5, id_externo)
       WHERE id = $2 RETURNING id, nome_cliente, status, recebido_em, plataforma, id_externo`,
      [status, req.params.id, recebido_em || null, plataforma || null, id_externo || null]
    );
    res.json({ sucesso: true, venda: r.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
});

// Log de eventos enviados pro CAPI (aba "Eventos")
router.get('/eventos', async (req, res) => {
  const tipo = req.query.tipo && req.query.tipo !== 'todos' ? req.query.tipo : null;
  const { inicio, fim } = periodoOuPadrao(req);
  try {
    const result = await pool.query(
      `SELECT * FROM eventos_capi
       WHERE ($1::text IS NULL OR evento = $1)
         AND enviado_em BETWEEN $2 AND ($3::date + INTERVAL '1 day')
       ORDER BY enviado_em DESC LIMIT 200`,
      [tipo, inicio, fim]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar eventos' });
  }
});

// Endpoint unico com TUDO que a Overview precisa, pra bater exatamente com a
// plataforma original: Resultado, Funil, Gateway, Agendamentos, Trafego & Qualidade
router.get('/overview', async (req, res) => {
  const { inicio, fim } = periodoOuPadrao(req);

  try {
    const gasto = await pool.query(
      `SELECT COALESCE(SUM(gasto), 0) as total,
              COALESCE(SUM(gasto) FILTER (WHERE moeda_original = 'BRL'), 0) as total_brl,
              COALESCE(SUM(impressoes), 0) as impressoes,
              COALESCE(SUM(cliques), 0) as cliques
       FROM ad_spend_daily WHERE data BETWEEN $1 AND $2`,
      [inicio, fim]
    );

    const vendasPorPlataforma = await pool.query(
      `SELECT plataforma, COALESCE(SUM(valor), 0) as total, COUNT(*) as qtd
       FROM sales WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')
       GROUP BY plataforma`,
      [inicio, fim]
    );

    const vendas = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as total,
              COUNT(*) FILTER (WHERE ad_id IS NOT NULL) as qtd_com_match
       FROM sales WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const leads = await pool.query(
      `SELECT COUNT(*) as qtd FROM leads WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const agendamentos = await pool.query(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as valor FROM sales
       WHERE status = 'agendamento' AND recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const gatewayResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE payload_bruto->'transaction'->>'payment_method' ILIKE '%boleto%'
                             OR payload_bruto->>'payment_method' ILIKE '%boleto%') as boletos,
         COUNT(*) FILTER (WHERE payload_bruto->'transaction'->>'payment_method' ILIKE '%pix%'
                             OR payload_bruto->>'payment_method' ILIKE '%pix%') as pix,
         COUNT(*) FILTER (WHERE status = 'recusada') as recusados
       FROM sales WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [inicio, fim]
    );

    const gastoTotal = parseFloat(gasto.rows[0].total);
    const gastoBrl = parseFloat(gasto.rows[0].total_brl);
    const imposto = Math.round(gastoBrl * 0.125 * 100) / 100;
    const investidoTotal = gastoTotal + imposto;
    const cliques = parseInt(gasto.rows[0].cliques, 10);

    const faturamentoTotal = vendasPorPlataforma.rows.reduce((soma, r) => soma + parseFloat(r.total), 0);
    const qtdVendas = parseInt(vendas.rows[0].qtd, 10);
    const qtdLeads = parseInt(leads.rows[0].qtd, 10);
    const qtdComMatch = parseInt(vendas.rows[0].qtd_com_match, 10);

    res.json({
      periodo: { inicio, fim },
      investido_total: investidoTotal,
      gasto_total: gastoTotal,
      imposto,
      faturamento_total: faturamentoTotal,
      faturamento_por_plataforma: vendasPorPlataforma.rows.map(r => ({
        plataforma: r.plataforma, total: parseFloat(r.total), qtd: parseInt(r.qtd, 10),
      })),
      roas_geral: investidoTotal > 0 ? Math.round((faturamentoTotal / investidoTotal) * 100) / 100 : null,
      lucro: faturamentoTotal - investidoTotal,
      leads: qtdLeads,
      cpl: qtdLeads > 0 ? Math.round((investidoTotal / qtdLeads) * 100) / 100 : null,
      vendas: qtdVendas,
      cpa: qtdVendas > 0 ? Math.round((investidoTotal / qtdVendas) * 100) / 100 : null,
      boletos_gerados: parseInt(gatewayResult.rows[0].boletos, 10),
      pix_gerados: parseInt(gatewayResult.rows[0].pix, 10),
      cartoes_recusados: parseInt(gatewayResult.rows[0].recusados, 10),
      agendamentos: parseInt(agendamentos.rows[0].qtd, 10),
      faturamento_agendado: parseFloat(agendamentos.rows[0].valor),
      cliques,
      cpc: cliques > 0 ? Math.round((investidoTotal / cliques) * 100) / 100 : null,
      match_rate: qtdVendas > 0 ? Math.round((qtdComMatch / qtdVendas) * 1000) / 10 : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao gerar overview' });
  }
});


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
       SELECT d.dia, COALESCE(g.total, 0) as gasto, COALESCE(v.total, 0) as faturamento,
              CASE WHEN COALESCE(g.total,0) > 0 THEN ROUND((COALESCE(v.total,0) / g.total)::numeric, 2) ELSE NULL END as roas
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

// Busca anuncios pelo nome, trazendo tambem o nome da campanha e do conjunto
// (o nome do anuncio sozinho pode se repetir em varias campanhas/contas
// diferentes -- isso ajuda a achar o ID certo cruzando os tres nomes).
router.get('/buscar-anuncio-completo', async (req, res) => {
  const nomes = (req.query.nomes || '').split(',').map(s => s.trim()).filter(Boolean);
  if (nomes.length === 0) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT ma.id, ma.nome as anuncio, mc.nome as campanha, mas.nome as conjunto,
              ma.ad_account_id, acc.nome as conta
       FROM meta_ads ma
       JOIN meta_adsets mas ON mas.id = ma.adset_id
       JOIN meta_campaigns mc ON mc.id = ma.campaign_id
       LEFT JOIN ad_accounts acc ON acc.id = ma.ad_account_id
       WHERE ma.nome = ANY($1::varchar[])`,
      [nomes]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar anuncios' });
  }
});

module.exports = router;
