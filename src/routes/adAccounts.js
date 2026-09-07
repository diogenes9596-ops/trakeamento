const express = require('express');
const pool = require('../db');
const { testarConexaoContaAnuncio, resolverContasEmLote } = require('../services/metaAdsService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, business_manager_id, ad_account_id, moeda, ativo, created_at,
              RIGHT(access_token, 4) as token_final
       FROM ad_accounts ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao listar contas de anuncio' });
  }
});

// Modo "Manual": cadastra uma conta por vez
router.post('/', async (req, res) => {
  const { nome, business_manager_id, ad_account_id, access_token } = req.body;

  if (!nome || !business_manager_id || !ad_account_id || !access_token) {
    return res.status(400).json({ erro: 'Preencha nome, BM ID, ID da conta de anuncio e token' });
  }

  const contaFormatada = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;

  try {
    const teste = await testarConexaoContaAnuncio(contaFormatada, access_token);
    if (!teste.ok) {
      return res.status(400).json({ erro: `Nao consegui validar essa conta no Meta: ${teste.mensagem}` });
    }

    const result = await pool.query(
      `INSERT INTO ad_accounts (nome, business_manager_id, ad_account_id, access_token, moeda)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, business_manager_id, ad_account_id, moeda, ativo`,
      [nome, business_manager_id, contaFormatada, access_token, teste.dados?.currency || 'BRL']
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao cadastrar conta de anuncio' });
  }
});

// Modo "Importar BM" — passo 1: cola BM ID + token + lista de account IDs,
// o sistema resolve nome e moeda de cada uma pra voce confirmar antes de salvar
router.post('/preview-lote', async (req, res) => {
  const { business_manager_id, access_token, account_ids_texto } = req.body;

  if (!business_manager_id || !access_token || !account_ids_texto) {
    return res.status(400).json({ erro: 'Preencha BM ID, token e a lista de account IDs' });
  }

  const ids = account_ids_texto.split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0) {
    return res.status(400).json({ erro: 'Nenhum account ID valido encontrado' });
  }

  try {
    const resolvidos = await resolverContasEmLote(ids, access_token);
    res.json({ business_manager_id, access_token, contas: resolvidos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao resolver contas' });
  }
});

// Modo "Importar BM" — passo 2: depois de confirmar na tela, salva as contas escolhidas
router.post('/importar-lote', async (req, res) => {
  const { business_manager_id, access_token, contas } = req.body;
  // contas: [{ ad_account_id, nome, moeda }, ...] — apenas as que o usuario confirmou

  if (!Array.isArray(contas) || contas.length === 0) {
    return res.status(400).json({ erro: 'Nenhuma conta selecionada' });
  }

  try {
    const salvas = [];
    for (const conta of contas) {
      const result = await pool.query(
        `INSERT INTO ad_accounts (nome, business_manager_id, ad_account_id, access_token, moeda)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, ad_account_id, moeda`,
        [conta.nome || conta.ad_account_id, business_manager_id, conta.ad_account_id, access_token, conta.moeda || 'BRL']
      );
      salvas.push(result.rows[0]);
    }
    res.status(201).json(salvas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao importar contas' });
  }
});

router.patch('/:id/status', async (req, res) => {
  const { ativo } = req.body;
  try {
    await pool.query('UPDATE ad_accounts SET ativo = $1 WHERE id = $2', [ativo, req.params.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar conta' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ad_accounts WHERE id = $1', [req.params.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao remover conta' });
  }
});

module.exports = router;
