const express = require('express');
const pool = require('../db');
const { encontrarLeadParaVenda, atribuirVendasPendentes } = require('../services/attributionService');
const { enviarEventoCapi } = require('../services/metaCapiService');

const router = express.Router();

function normalizarTelefoneBR(telefone) {
  if (!telefone) return null;
  let digitos = telefone.replace(/\D/g, '');
  if (digitos && !digitos.startsWith('55')) {
    digitos = '55' + digitos;
  }
  return digitos;
}

// Lança uma venda manualmente (fora de qualquer webhook). Se o telefone bater
// com um lead existente, a atribuição é herdada automaticamente.
router.post('/lancar-venda', async (req, res) => {
  const { telefone, email, nome, pais, estado, cidade, cep, produto_id, valor, data, pular_capi } = req.body;

  if (!telefone && !email) {
    return res.status(400).json({ erro: 'Informe pelo menos telefone ou email' });
  }

  try {
    const telefoneNormalizado = normalizarTelefoneBR(telefone);
    const idExterno = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let produtoNome = null;
    let valorFinal = parseFloat(valor || 0);

    if (produto_id) {
      const produto = await pool.query('SELECT * FROM produtos_manuais WHERE id = $1', [produto_id]);
      if (produto.rows[0]) {
        produtoNome = produto.rows[0].nome;
        if (!valor) valorFinal = parseFloat(produto.rows[0].valor || 0);
      }
    }

    // "data" (YYYY-MM-DD) e opcional -- usado pra lancar vendas de dias
    // anteriores (ex: importando um historico da Skale) com a data real da
    // venda, em vez de sempre cair em "agora". Sem isso, um lote de vendas
    // de dias diferentes ficaria todo empilhado no dia do lancamento.
    const recebidoEm = data ? `${data}T12:00:00Z` : null;

    const result = await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto, recebido_em)
       VALUES ('manual', $1, 'aprovada', $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()))
       RETURNING *`,
      [idExterno, telefoneNormalizado, email || null, nome || null, valorFinal, produtoNome,
       JSON.stringify({ pais, estado, cidade, cep }), recebidoEm]
    );

    const venda = result.rows[0];

    // Atribuicao imediata: procura lead com esse telefone
    if (telefoneNormalizado) {
      const janelaHoras = parseInt(process.env.JANELA_ATRIBUICAO_HORAS || '72', 10);
      const lead = await encontrarLeadParaVenda(telefoneNormalizado, venda.recebido_em, janelaHoras);
      if (lead) {
        await pool.query(
          `UPDATE sales SET ad_id = $1, lead_id = $2, atribuido_em = NOW() WHERE id = $3`,
          [lead.ad_id, lead.id, venda.id]
        );
      } else {
        await pool.query(`UPDATE sales SET atribuido_em = NOW() WHERE id = $1`, [venda.id]);
      }
    }

    // "pular_capi": true evita mandar o evento de Purchase pro Meta -- essencial
    // ao importar historico (vendas antigas), ja que a compra original
    // provavelmente ja disparou o evento de verdade na epoca; reenviar aqui
    // so duplicaria a conversao no Gerenciador de Anuncios com a data de hoje.
    if (!pular_capi) {
      await enviarEventoCapi({ evento: 'Purchase', telefone: telefoneNormalizado, valor: valorFinal, eventId: idExterno });
    }

    res.status(201).json(venda);
  } catch (err) {
    console.error('Erro ao lancar venda manual:', err);
    res.status(500).json({ erro: 'Erro ao lancar venda manual' });
  }
});

// --- Produtos (usados no dropdown do formulario acima) ---

// Lanca um lead manualmente com data e ad_id conhecidos -- usado ao importar
// historico de uma plataforma de rastreamento anterior, pra permitir que a
// atribuicao (por telefone) funcione nas vendas ja lancadas daquele periodo.
router.post('/lancar-lead', async (req, res) => {
  const { telefone, ad_id, data_hora } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'Informe o telefone' });

  try {
    const telefoneNormalizado = normalizarTelefoneBR(telefone);
    const recebidoEm = data_hora || null;
    const result = await pool.query(
      `INSERT INTO leads (telefone, origem, ad_id, recebido_em)
       VALUES ($1, 'importado_historico', $2, COALESCE($3::timestamptz, NOW()))
       RETURNING *`,
      [telefoneNormalizado, ad_id || null, recebidoEm]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao lancar lead manual:', err);
    res.status(500).json({ erro: 'Erro ao lancar lead manual' });
  }
});

// Reseta a atribuicao das vendas de um periodo (zera ad_id/lead_id/atribuido_em)
// e roda a atribuicao de novo -- usado depois de importar leads historicos,
// pra essas vendas antigas terem chance de bater com os leads novos.
router.post('/reatribuir', async (req, res) => {
  const { data_inicio, data_fim } = req.body;
  if (!data_inicio || !data_fim) return res.status(400).json({ erro: 'Informe data_inicio e data_fim' });

  try {
    await pool.query(
      `UPDATE sales SET ad_id = NULL, lead_id = NULL, atribuido_em = NULL
       WHERE recebido_em BETWEEN $1 AND ($2::date + INTERVAL '1 day')`,
      [data_inicio, data_fim]
    );
    const relatorio = await atribuirVendasPendentes();
    res.json({ sucesso: true, relatorio });
  } catch (err) {
    console.error('Erro ao reatribuir:', err);
    res.status(500).json({ erro: 'Erro ao reatribuir' });
  }
});

router.get('/produtos', async (req, res) => {
  const result = await pool.query('SELECT * FROM produtos_manuais ORDER BY created_at DESC');
  res.json(result.rows);
});

router.post('/produtos', async (req, res) => {
  const { product_id, nome, valor, ativo } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Informe o nome do produto' });

  try {
    const result = await pool.query(
      `INSERT INTO produtos_manuais (product_id, nome, valor, ativo) VALUES ($1,$2,$3,$4) RETURNING *`,
      [product_id || null, nome, valor || null, ativo !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao cadastrar produto' });
  }
});

router.delete('/produtos/:id', async (req, res) => {
  await pool.query('DELETE FROM produtos_manuais WHERE id = $1', [req.params.id]);
  res.json({ sucesso: true });
});

// Envio MANUAL e pontual de Purchase pro Meta CAPI para as vendas aprovadas
// de uma data (default: hoje). Isso e so-esse-disparo, a pedido do usuario --
// o envio automatico continua desligado permanentemente no webhook da Skale.
router.post('/enviar-vendas-meta', async (req, res) => {
  const data = req.body?.data || new Date().toISOString().slice(0, 10);
  try {
    const vendas = await pool.query(
      `SELECT id, id_externo, plataforma, telefone, valor, nome_cliente
       FROM sales
       WHERE status = 'aprovada' AND recebido_em BETWEEN $1 AND ($1::date + INTERVAL '1 day')`,
      [data]
    );

    const enviados = [];
    const falhas = [];
    for (const v of vendas.rows) {
      try {
        await enviarEventoCapi({
          evento: 'Purchase',
          telefone: v.telefone,
          valor: parseFloat(v.valor),
          eventId: `manual_${v.plataforma || 'skale'}_${v.id_externo || v.id}`,
        });
        enviados.push({ id: v.id, nome: v.nome_cliente, valor: v.valor });
      } catch (err) {
        console.error(`Erro ao enviar venda ${v.id} pro Meta:`, err.message);
        falhas.push({ id: v.id, nome: v.nome_cliente, erro: err.message });
      }
    }

    res.json({ data, total_vendas: vendas.rows.length, enviados, falhas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao enviar vendas pro Meta' });
  }
});

module.exports = router;

