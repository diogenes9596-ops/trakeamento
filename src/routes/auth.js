const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { exigirLogin } = require('../middleware/auth');

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

// Cada pessoa troca a propria senha (exige saber a senha atual, nao precisa
// ser admin). Essencial pra distribuir o sistema pra clientes -- sem isso,
// toda troca de senha exigiria mexer direto no banco de dados.
router.post('/trocar-senha', exigirLogin, async (req, res) => {
  const { senha_atual, senha_nova } = req.body;

  if (!senha_atual || !senha_nova) {
    return res.status(400).json({ erro: 'Informe a senha atual e a nova senha' });
  }
  if (senha_nova.length < 6) {
    return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 6 caracteres' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const usuario = result.rows[0];
    if (!usuario) {
      return res.status(401).json({ erro: 'Sessao invalida, faca login novamente' });
    }

    const senhaOk = await bcrypt.compare(senha_atual, usuario.password_hash);
    if (!senhaOk) {
      return res.status(401).json({ erro: 'Senha atual incorreta' });
    }

    const novoHash = await bcrypt.hash(senha_nova, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [novoHash, usuario.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao trocar senha:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
