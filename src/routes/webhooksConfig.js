const express = require('express');
const { obterSecret, salvarSecret, gerarSecretAleatorio } = require('../services/webhookSecretsService');
const { listarProblemas } = require('../services/webhooksRecebidosService');

const router = express.Router();

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/', async (req, res) => {
  const base = baseUrl(req);
  const [datacrazy, payt, skale] = await Promise.all([
    obterSecret('datacrazy'),
    obterSecret('payt'),
    obterSecret('skale'),
  ]);

  res.json({
    datacrazy: {
      url: `${base}/webhook/datacrazy`,
      autenticacao: 'header x-datacrazy-secret',
      secret: datacrazy,
      payload_esperado: {
        phone: '5511999998888',
        ctwa_clid: 'ARAbc123...',
        source_id: '120210000000000',
        source_url: 'https://wa.me/...',
        page_id: '100000000000000',
      },
    },
    payt: {
      url: `${base}/webhook/payt?token=${payt}`,
      autenticacao: 'query string ?token=',
      secret: payt,
    },
    skale: {
      url: `${base}/webhook/skale?token=${skale}`,
      autenticacao: 'query string ?token= ou header x-skale-secret',
      secret: skale,
    },
  });
});

// Log de problemas dos webhooks (evento com erro ou preso sem processar) --
// lista da aba Configuracoes > Webhooks.
router.get('/erros', async (req, res) => {
  try {
    res.json(await listarProblemas(100));
  } catch (err) {
    console.error('Erro ao listar problemas dos webhooks:', err);
    res.status(500).json({ erro: 'Erro ao listar problemas dos webhooks' });
  }
});

router.post('/:servico/regenerar', async (req, res) => {
  const { servico } = req.params;
  if (!['datacrazy', 'payt', 'skale'].includes(servico)) {
    return res.status(400).json({ erro: 'Servico invalido' });
  }
  const novoSecret = gerarSecretAleatorio();
  await salvarSecret(servico, novoSecret);
  res.json({ secret: novoSecret });
});

router.post('/:servico/definir', async (req, res) => {
  const { servico } = req.params;
  const { secret } = req.body;
  if (!['datacrazy', 'payt', 'skale'].includes(servico)) {
    return res.status(400).json({ erro: 'Servico invalido' });
  }
  if (!secret || secret.length < 8) {
    return res.status(400).json({ erro: 'O secret precisa ter pelo menos 8 caracteres' });
  }
  await salvarSecret(servico, secret);
  res.json({ sucesso: true });
});

module.exports = router;
