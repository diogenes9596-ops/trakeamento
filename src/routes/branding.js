const express = require('express');
const pool = require('../db');
const { exigirLogin } = require('../middleware/auth');

const router = express.Router();

// Publica (sem exigir login) -- a tela de login precisa saber o nome/logo
// antes da pessoa entrar.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT nome, tagline, logo_url FROM branding WHERE id = 1');
    const linha = result.rows[0] || { nome: 'Sua Marca', tagline: 'TRACKING', logo_url: null };
    res.json(linha);
  } catch (err) {
    console.error(err);
    res.json({ nome: 'Sua Marca', tagline: 'TRACKING', logo_url: null });
  }
});

// Salvar (exige login mesmo essa rota estando montada publicamente)
router.post('/', exigirLogin, async (req, res) => {
  const { nome, tagline } = req.body;
  // Se a pessoa nao mandou um logo novo nessa chamada, mantem o que ja tinha
  // salvo (em vez de apagar o logo so porque ela editou o nome, por exemplo).
  const logoEnviado = Object.prototype.hasOwnProperty.call(req.body, 'logo_url');
  const logo_url = req.body.logo_url;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'O nome da marca nao pode ficar vazio' });
  }
  // Um logo em base64 pode ficar grande -- limite generoso de 2MB pra nao
  // deixar o banco pesado com imagens gigantes.
  if (logoEnviado && logo_url && logo_url.length > 2 * 1024 * 1024) {
    return res.status(400).json({ erro: 'Essa imagem e grande demais. Use um logo menor (ate ~1MB).' });
  }

  try {
    if (logoEnviado) {
      await pool.query(
        `INSERT INTO branding (id, nome, tagline, logo_url, atualizado_em)
         VALUES (1, $1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, tagline = EXCLUDED.tagline,
           logo_url = EXCLUDED.logo_url, atualizado_em = NOW()`,
        [nome.trim(), (tagline || '').trim() || 'TRACKING', logo_url || null]
      );
    } else {
      await pool.query(
        `INSERT INTO branding (id, nome, tagline, atualizado_em)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, tagline = EXCLUDED.tagline, atualizado_em = NOW()`,
        [nome.trim(), (tagline || '').trim() || 'TRACKING']
      );
    }
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao salvar a marca' });
  }
});

module.exports = router;
