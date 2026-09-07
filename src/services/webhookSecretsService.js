const crypto = require('crypto');
const pool = require('../db');

async function obterSecret(servico) {
  const result = await pool.query('SELECT secret FROM webhook_secrets WHERE servico = $1', [servico]);
  return result.rows[0]?.secret || null;
}

async function salvarSecret(servico, secret) {
  await pool.query(
    `INSERT INTO webhook_secrets (servico, secret) VALUES ($1, $2)
     ON CONFLICT (servico) DO UPDATE SET secret = EXCLUDED.secret, updated_at = NOW()`,
    [servico, secret]
  );
}

function gerarSecretAleatorio() {
  return crypto.randomBytes(16).toString('hex');
}

// Garante que exista um secret pra cada servico (gera um na primeira vez que o
// servidor sobe, caso ainda nao tenha sido definido pelo painel)
async function garantirSecretsIniciais() {
  const servicos = ['datacrazy', 'payt', 'skale'];
  for (const servico of servicos) {
    const existente = await obterSecret(servico);
    if (!existente) {
      await salvarSecret(servico, gerarSecretAleatorio());
      console.log(`Secret inicial gerado para "${servico}" (configure em Configuracoes > Webhooks).`);
    }
  }
}

module.exports = { obterSecret, salvarSecret, gerarSecretAleatorio, garantirSecretsIniciais };
