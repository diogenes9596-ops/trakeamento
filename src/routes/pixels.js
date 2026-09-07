const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT id, nome, pixel_id, eventos_capi, is_default, created_at, RIGHT(access_token, 4) as token_final
     FROM pixels ORDER BY created_at DESC`
  );
  res.json(result.rows);
});

router.post('/', async (req, res) => {
  const { nome, pixel_id, access_token, is_default } = req.body;
  if (!nome || !pixel_id || !access_token) {
    return res.status(400).json({ erro: 'Preencha nome, pixel ID e token' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (is_default) {
      await client.query('UPDATE pixels SET is_default = FALSE');
    }

    const result = await client.query(
      `INSERT INTO pixels (nome, pixel_id, access_token, is_default)
       VALUES ($1, $2, $3, $4) RETURNING id, nome, pixel_id, is_default`,
      [nome, pixel_id, access_token, !!is_default]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ erro: 'Erro ao cadastrar pixel' });
  } finally {
    client.release();
  }
});

// Define quais eventos esse pixel recebe via CAPI: so venda (Purchase),
// ou venda + agendamento (Purchase + Lead)
router.patch('/:id/eventos-capi', async (req, res) => {
  const { eventos_capi } = req.body; // 'venda' | 'venda_agendamento'
  await pool.query('UPDATE pixels SET eventos_capi = $1 WHERE id = $2', [eventos_capi, req.params.id]);
  res.json({ sucesso: true });
});

router.post('/:id/tornar-default', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE pixels SET is_default = FALSE');
    await client.query('UPDATE pixels SET is_default = TRUE WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ sucesso: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro ao definir pixel default' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM pixels WHERE id = $1', [req.params.id]);
  res.json({ sucesso: true });
});

module.exports = router;
