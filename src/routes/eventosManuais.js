const express = require('express');
const pool = require('../db');
const { encontrarLeadParaVenda } = require('../services/attributionService');
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
  const { telefone, email, nome, pais, estado, cidade, cep, produto_id, valor } = req.body;

  if (!telefone && !email) {
    return res.status(400).json({ erro: 'Informe pelo menos telefone ou email' });
  }

  try {
    const telefoneNormalizado = normalizarTelefoneBR(telefone);
    const idExterno = `manual_${Date.now()}`;

    let produtoNome = null;
    let valorFinal = parseFloat(valor || 0);

    if (produto_id) {
      const produto = await pool.query('SELECT * FROM produtos_manuais WHERE id = $1', [produto_id]);
      if (produto.rows[0]) {
        produtoNome = produto.rows[0].nome;
        if (!valor) valorFinal = parseFloat(produto.rows[0].valor || 0);
      }
    }

    const result = await pool.query(
      `INSERT INTO sales (plataforma, id_externo, status, telefone, email, nome_cliente, valor, produto, payload_bruto)
       VALUES ('manual', $1, 'aprovada', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [idExterno, telefoneNormalizado, email || null, nome || null, valorFinal, produtoNome,
       JSON.stringify({ pais, estado, cidade, cep })]
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

    await enviarEventoCapi({ evento: 'Purchase', telefone: telefoneNormalizado, valor: valorFinal, eventId: idExterno });

    res.status(201).json(venda);
  } catch (err) {
    console.error('Erro ao lancar venda manual:', err);
    res.status(500).json({ erro: 'Erro ao lancar venda manual' });
  }
});

// --- Produtos (usados no dropdown do formulario acima) ---

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

module.exports = router;
