const pool = require('../db');

// Registro de todo evento que chega nos webhooks, gravado ANTES de responder
// "ok" pra plataforma (pedido do usuario em 16/09/2026). Antes o webhook da
// Skale respondia "ok" e so depois gravava a venda: se o banco falhasse nesse
// intervalo, a Skale achava que tinha entregado e a venda sumia sem rastro
// (so uma linha no log do Railway). Agora o payload fica guardado aqui, e o
// que der errado no processamento aparece em Configuracoes > Webhooks.
//
// status: 'recebido'   -> gravado, ainda nao processado
//         'processado' -> venda gravada/atualizada
//         'erro'       -> processamento falhou (mensagem em "erro")

const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS webhooks_recebidos (
    id SERIAL PRIMARY KEY,
    servico VARCHAR(30) NOT NULL,
    id_externo VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'recebido',
    erro TEXT,
    payload JSONB,
    recebido_em TIMESTAMPTZ DEFAULT NOW(),
    processado_em TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_webhooks_recebidos_status ON webhooks_recebidos(status, recebido_em);
`;

// O deploy (Railway) so roda "node src/server.js" -- o schema.sql NAO e
// aplicado sozinho. Por isso o servidor garante a tabela ao subir (a mesma
// definicao esta no schema.sql, pra instalacao nova via npm run migrate).
async function garantirTabelaWebhooksRecebidos() {
  await pool.query(SQL_TABELA);
}

async function registrarRecebimento(servico, payload) {
  const r = await pool.query(
    `INSERT INTO webhooks_recebidos (servico, payload) VALUES ($1, $2) RETURNING id`,
    [servico, JSON.stringify(payload ?? null)]
  );
  return r.rows[0].id;
}

async function marcarProcessado(id, idExterno) {
  await pool.query(
    `UPDATE webhooks_recebidos SET status = 'processado', id_externo = $2, erro = NULL, processado_em = NOW()
     WHERE id = $1`,
    [id, idExterno || null]
  );
}

async function marcarErro(id, mensagem, idExterno) {
  await pool.query(
    `UPDATE webhooks_recebidos SET status = 'erro', erro = $2, id_externo = COALESCE($3, id_externo), processado_em = NOW()
     WHERE id = $1`,
    [id, String(mensagem || 'Erro sem mensagem'), idExterno || null]
  );
}

// Lista do painel: eventos com erro e eventos que ficaram presos em 'recebido'
// por mais de 5 minutos (servidor caiu ou reiniciou no meio do processamento).
// Nao devolve o payload -- ele fica no banco, consultavel pelo id.
async function listarProblemas(limite = 100) {
  const r = await pool.query(
    `SELECT id, servico, id_externo, status, erro, recebido_em, processado_em
     FROM webhooks_recebidos
     WHERE status = 'erro'
        OR (status = 'recebido' AND recebido_em < NOW() - INTERVAL '5 minutes')
     ORDER BY recebido_em DESC
     LIMIT $1`,
    [limite]
  );
  return r.rows;
}

module.exports = {
  garantirTabelaWebhooksRecebidos,
  registrarRecebimento,
  marcarProcessado,
  marcarErro,
  listarProblemas,
};
