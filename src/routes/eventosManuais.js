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
  const { id_externo, telefone, email, nome, pais, estado, cidade, cep, produto_id, valor, data } = req.body;

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

    // Lancamento manual NAO envia nada pro Meta (decisao do usuario em
    // 16/09/2026: nada dispara pro Meta sozinho, nem como efeito colateral de
    // registrar uma venda). Antes disparava Purchase a nao ser que viesse
    // pular_capi -- que o formulario do painel nem oferecia. Envio ao CAPI
    // agora so pela rota /enviar-vendas-meta, abaixo.

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

function dataValida(data) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(data || ''));
}

// "Hoje" no horario de Brasilia -- toISOString() devolve UTC e, depois das
// 21h, ja seria o dia seguinte.
function hojeEmBrasilia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

// Vendas aprovadas de um dia do pagamento (o pool ja roda em
// America/Sao_Paulo, entao $1::date e a meia-noite de Brasilia). Intervalo
// meio-aberto [dia, dia+1): o BETWEEN antigo incluia a meia-noite seguinte nos
// dois dias. "ja_enviada" = o Meta ja aceitou um Purchase dessa venda antes,
// por este envio manual (manual_...) ou pelo automatico da Skale que existiu
// de 15 a 16/09/2026 (skale_...).
async function vendasAprovadasDoDia(data) {
  const r = await pool.query(
    `SELECT s.id, s.id_externo, s.plataforma, s.telefone, s.valor, s.nome_cliente, s.recebido_em, l.ctwa_clid,
            EXISTS (
              SELECT 1 FROM eventos_capi e
              WHERE e.status = 'ok' AND e.evento = 'Purchase'
                AND e.payload->'enviado'->>'event_id' IN (
                  'manual_' || COALESCE(s.plataforma, 'skale') || '_' || COALESCE(s.id_externo, s.id::text),
                  'skale_' || s.id_externo
                )
            ) AS ja_enviada
     FROM sales s
     LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.status = 'aprovada'
       AND s.recebido_em >= $1::date
       AND s.recebido_em < $1::date + INTERVAL '1 day'
     ORDER BY s.recebido_em`,
    [data]
  );
  return r.rows;
}

// Pre-visualizacao da aba "Enviar ao Meta": o que seria enviado, sem enviar.
router.get('/vendas-para-meta', async (req, res) => {
  const data = req.query.data || hojeEmBrasilia();
  if (!dataValida(data)) return res.status(400).json({ erro: 'Data invalida, use AAAA-MM-DD' });
  try {
    const vendas = await vendasAprovadasDoDia(data);
    res.json({
      data,
      vendas: vendas.map(v => ({
        id: v.id, id_externo: v.id_externo, plataforma: v.plataforma, nome_cliente: v.nome_cliente,
        valor: v.valor, recebido_em: v.recebido_em, tem_ctwa_clid: !!v.ctwa_clid, ja_enviada: v.ja_enviada,
      })),
    });
  } catch (err) {
    console.error('Erro ao listar vendas pra enviar ao Meta:', err);
    res.status(500).json({ erro: 'Erro ao listar vendas do dia' });
  }
});

// Envio MANUAL de Purchase pro Meta CAPI das vendas aprovadas de um dia --
// botao "Enviar ao Meta" da pagina Eventos Manuais. E o UNICO lugar do sistema
// que envia algo ao Meta: nenhum webhook e nem o lancamento manual enviam.
router.post('/enviar-vendas-meta', async (req, res) => {
  const data = req.body?.data || hojeEmBrasilia();
  if (!dataValida(data)) return res.status(400).json({ erro: 'Data invalida, use AAAA-MM-DD' });
  try {
    const vendas = await vendasAprovadasDoDia(data);

    const enviados = [];
    const falhas = [];
    for (const v of vendas) {
      try {
        const resultado = await enviarEventoCapi({
          evento: 'Purchase',
          telefone: v.telefone,
          valor: parseFloat(v.valor),
          eventId: `manual_${v.plataforma || 'skale'}_${v.id_externo || v.id}`,
          ctwaClid: v.ctwa_clid || null,
        });
        if (resultado?.ok) {
          enviados.push({ id: v.id, nome: v.nome_cliente, valor: v.valor });
        } else {
          falhas.push({ id: v.id, nome: v.nome_cliente, erro: resultado?.erro || 'Envio nao confirmado' });
        }
      } catch (err) {
        console.error(`Erro ao enviar venda ${v.id} pro Meta:`, err.message);
        falhas.push({ id: v.id, nome: v.nome_cliente, erro: err.message });
      }
    }

    console.log(`Envio manual ao Meta (${data}): ${enviados.length} enviada(s), ${falhas.length} falha(s).`);
    res.json({ data, total_vendas: vendas.length, enviados, falhas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao enviar vendas pro Meta' });
  }
});

module.exports = router;

