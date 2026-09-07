const express = require('express');
const pool = require('../db');
const { buscarCotacaoAoVivo, salvarCotacaoDoDia, salvarFallback } = require('../services/fxService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const porDia = await pool.query('SELECT * FROM fx_rates ORDER BY data DESC LIMIT 60');
    const fallback = await pool.query('SELECT * FROM fx_fallback_config WHERE id = 1');
    let cotacaoAoVivo = null;
    try {
      cotacaoAoVivo = await buscarCotacaoAoVivo();
    } catch (e) { /* segue sem a cotacao ao vivo se a API estiver fora */ }

    res.json({ por_dia: porDia.rows, fallback: fallback.rows[0], cotacao_ao_vivo: cotacaoAoVivo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao carregar cotacoes' });
  }
});

router.post('/dia', async (req, res) => {
  const { data, cotacao } = req.body;
  if (!data || !cotacao) return res.status(400).json({ erro: 'Informe data e cotacao' });
  await salvarCotacaoDoDia(data, cotacao);
  res.json({ sucesso: true });
});

router.post('/fallback', async (req, res) => {
  const { modo, valor_manual } = req.body;
  if (!['automatico', 'manual'].includes(modo)) {
    return res.status(400).json({ erro: 'Modo invalido' });
  }
  await salvarFallback(modo, valor_manual);
  res.json({ sucesso: true });
});

module.exports = router;
