const pool = require('../db');

// Deixa so digitos no telefone e pega os ultimos 8-9 digitos (numero local),
// pra nao dar problema de comparar com/sem "55", com/sem "9" na frente, etc.
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  const digitos = String(telefone).replace(/\D/g, '');
  if (digitos.length <= 9) return digitos;
  return digitos.slice(-9); // ultimos 9 digitos (DDD + numero, sem o 9 as vezes)
}

// Tenta encontrar o lead (clique no anuncio) que originou essa venda,
// procurando pelo telefone dentro da janela de tempo configurada.
// Compara tanto pelos ultimos 9 digitos quanto pelos ultimos 8 -- o "9" que
// prefixa celulares no Brasil as vezes vem de um lado e nao do outro (ex:
// Skale manda com o 9, DataCrazy manda sem), o que fazia esses dois
// numeros -- que sao a MESMA pessoa -- nunca baterem usando so o RIGHT(9).
async function encontrarLeadParaVenda(telefoneVenda, dataVenda, janelaHoras) {
  const tel = normalizarTelefone(telefoneVenda);
  if (!tel) return null;
  const tel8 = tel.slice(-8);

  const result = await pool.query(
    `SELECT * FROM leads
     WHERE (
       RIGHT(REGEXP_REPLACE(telefone, '\\D', '', 'g'), 9) = $1
       OR RIGHT(REGEXP_REPLACE(telefone, '\\D', '', 'g'), 8) = $4
     )
       AND recebido_em <= $2
       AND recebido_em >= $2::timestamptz - ($3 || ' hours')::interval
     ORDER BY recebido_em DESC
     LIMIT 1`,
    [tel, dataVenda, janelaHoras, tel8]
  );

  return result.rows[0] || null;
}

// Roda a atribuicao para vendas que ainda nao foram processadas
async function atribuirVendasPendentes() {
  const janelaHoras = parseInt(process.env.JANELA_ATRIBUICAO_HORAS || '72', 10);

  const vendas = await pool.query(
    `SELECT * FROM sales WHERE atribuido_em IS NULL ORDER BY recebido_em ASC LIMIT 500`
  );

  let atribuidas = 0;
  let semLead = 0;

  for (const venda of vendas.rows) {
    const lead = await encontrarLeadParaVenda(venda.telefone, venda.recebido_em, janelaHoras);

    if (lead) {
      await pool.query(
        `UPDATE sales SET ad_id = $1, lead_id = $2, atribuido_em = NOW() WHERE id = $3`,
        [lead.ad_id, lead.id, venda.id]
      );
      atribuidas++;
    } else {
      // marca como processada mesmo sem achar lead, pra nao ficar tentando pra sempre
      // (fica com ad_id = NULL, aparece como "sem atribuicao" no dashboard)
      await pool.query(`UPDATE sales SET atribuido_em = NOW() WHERE id = $1`, [venda.id]);
      semLead++;
    }
  }

  return { total: vendas.rows.length, atribuidas, semLead };
}

module.exports = { normalizarTelefone, encontrarLeadParaVenda, atribuirVendasPendentes };
