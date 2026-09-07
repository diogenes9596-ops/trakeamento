const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM atendentes ORDER BY created_at DESC');
  res.json(result.rows);
});

router.post('/', async (req, res) => {
  const { email, nome } = req.body;
  if (!email) return res.status(400).json({ erro: 'Informe o email' });

  try {
    const result = await pool.query(
      `INSERT INTO atendentes (email, nome) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, ativo = TRUE
       RETURNING *`,
      [email, nome || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao cadastrar atendente' });
  }
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM atendentes WHERE id = $1', [req.params.id]);
  res.json({ sucesso: true });
});

module.exports = router;
