require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { garantirSecretsIniciais } = require('./services/webhookSecretsService');

async function migrate() {
  console.log('Aplicando schema.sql...');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema aplicado com sucesso.');

  const email = process.env.ADMIN_EMAIL;
  const senha = process.env.ADMIN_PASSWORD;

  if (!email || !senha) {
    console.log('ADMIN_EMAIL/ADMIN_PASSWORD nao definidos no .env — pulei a criacao do usuario.');
    return;
  }

  const existente = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existente.rows.length > 0) {
    console.log('Usuario admin ja existe, nada a fazer.');
    return;
  }

  const hash = await bcrypt.hash(senha, 10);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  console.log(`Usuario admin criado: ${email}`);

  await garantirSecretsIniciais();
}

migrate()
  .then(() => {
    console.log('Migracao concluida.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Erro na migracao:', err);
    process.exit(1);
  });
