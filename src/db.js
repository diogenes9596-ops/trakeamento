const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  // Sem isso, o Postgres compara as datas dos filtros (ex: "2026-09-07") usando
  // o fuso UTC por padrao -- isso desalinhava o inicio/fim do dia em 3 horas
  // em relacao ao horario de Brasilia, fazendo o filtro "Hoje" pegar um
  // pedaco errado (misturando o fim de ontem com o comeco de hoje).
  options: '-c timezone=America/Sao_Paulo',
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do banco de dados:', err);
});

module.exports = pool;
