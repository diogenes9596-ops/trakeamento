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

// LanÃ§a uma venda manualmente (fora de qualquer webhook). Se o telefone bater
// com um lead existente, a atribuiÃ§Ã£o Ã© herdada automaticamente.
router.post('/lancar-venda', async (req, res) => {
  const { id_externo, telefone, email, nome, pais, estado, cidade, cep, produto_id, valor, data, pular_capi } = req.body;

  if (!telefone && !email) {
    return res.status(400).json({ erro: 'Informe pelo menos telefone ou email' });
  }

  try {
    const telefoneNormalizado = normalizarTelefoneBR(telefone);

    // Todo lancamento manual corresponde a um pedido REAL da Skale, entao o
    // certo e gravar com o id_externo de la (ven_XXXXXX) e plataforma
    // "skale": e o par (plataforma, id_externo) que segura a duplicata --
    // quando o webhook de verdade chegar, ele cai NESSE registro em vez de
    // criar outro. Inventar um id aqui e o que ja gerou dezenas de vendas
    // duplicadas, por isso o "manual_<timestamp>" so sobrou como ultimo
    // recurso, com aviso no log.
    const idSkale = String(id_externo || '').trim();
    const plataforma = idSkale ? 'skale' : 'manual';
    const idExterno = idSkale || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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

    if (!idSkale) {
      console.warn(
        '\n===================== ATENCAO =====================\n' +
        'Venda manual lancada SEM o id do pedido na Skale.\n' +
        `Id provisorio gerado: ${idExterno} (plataforma "manual").\n` +
        'Pelo processo do negocio isso nao deveria acontecer: todo pedido\n' +
        'lancado manualmente existe na Skale. Como a chave unica e o par\n' +
        '(plataforma, id_externo), quando o webhook real desse pedido chegar\n' +
        'ele vai criar OUTRA linha e a venda aparece duplicada no painel.\n' +
        `Cliente: ${nome || '(sem nome)'} | telefone: ${telefoneNormalizado || '(sem telefone)'} | valor: ${valorFinal}\n` +
        '===================================================\n'
      );
    }

    const result = await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto, recebido_em)
       VALUES ($1, $2, 'aprovada', $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
       RETURNING *`,
      [plataforma, idExterno, telefoneNormalizado, email || null, nome || null, valorFinal, produtoNome,
       JSON.stringify({ pais, estado, cidade, cep }), recebidoEm]
    );

    const venda = result.rows[0];

    // Atribuicao imediata: procura lead com esse telefone
    if (telefoneNormalizado) {
      const janelaHoras = parseInt(process.env.JANELA_ATRIBUICAO_HORAS || '720', 10);
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
      // Com id da Skale, usa exatamente o mesmo event_id que o webhook dela
      // usaria pra esse pedido (skale_<id>) -- assim, se o webhook chegar
      // depois e disparar o Purchase dele, o Meta deduplica os dois em vez
      // de contar a conversao duas vezes.
      const eventId = plataforma === 'skale' ? `skale_${idExterno}` : idExterno;
      await enviarEventoCapi({ evento: 'Purchase', telefone: telefoneNormalizado, valor: valorFinal, eventId });
    }

    res.status(201).json(venda);
  } catch (err) {
    // 23505 = violacao do UNIQUE (plataforma, id_externo): esse pedido ja
    // esta no banco, quase sempre porque o webhook da Skale ja registrou ele.
    // Melhor recusar e avisar do que gravar uma segunda linha do mesmo pedido.
    if (err.code === '23505') {
      console.warn(`Lancamento manual recusado: ja existe venda com id_externo "${req.body?.id_externo}".`);
      return res.status(409).json({ erro: 'Ja existe uma venda com esse ID da Skale. Confira na aba Vendas.' });
    }
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
      `SELECT s.id, s.id_externo, s.plataforma, s.telefone, s.valor, s.nome_cliente, l.ctwa_clid
       FROM sales s
       LEFT JOIN leads l ON l.id = s.lead_id
       WHERE s.status = 'aprovada' AND s.recebido_em BETWEEN $1 AND ($1::date + INTERVAL '1 day')`,
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
          ctwaClid: v.ctwa_clid || null,
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

