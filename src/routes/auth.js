const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe email e senha' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const usuario = result.rows[0];

    if (!usuario) {
      return res.status(401).json({ erro: 'Email ou senha invalidos' });
    }

    const senhaOk = await bcrypt.compare(senha, usuario.password_hash);
    if (!senhaOk) {
      return res.status(401).json({ erro: 'Email ou senha invalidos' });
    }

    req.session.userId = usuario.id;
    req.session.email = usuario.email;
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ sucesso: true });
  });
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ autenticado: true, email: req.session.email });
  }
  res.json({ autenticado: false });
});

module.exports = router;
