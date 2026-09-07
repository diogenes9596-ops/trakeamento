const axios = require('axios');
const pool = require('../db');

// Cache em memoria da cotacao ao vivo, pra nao estourar o limite de requisicoes
// da API quando sincronizamos varios dias/anuncios de uma vez
let cacheCotacaoAoVivo = { valor: null, buscadoEm: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Busca a cotação ao vivo (fonte: AwesomeAPI, mesma usada pela plataforma original)
async function buscarCotacaoAoVivo() {
  const agora = Date.now();
  if (cacheCotacaoAoVivo.valor && (agora - cacheCotacaoAoVivo.buscadoEm) < CACHE_TTL_MS) {
    return cacheCotacaoAoVivo.valor;
  }

  const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL');
  const valor = parseFloat(data.USDBRL.bid);
  cacheCotacaoAoVivo = { valor, buscadoEm: agora };
  return valor;
}

// Cotação a usar pra uma data especifica: primeiro tenta a cotação daquele dia
// cadastrada manualmente; se nao tiver, usa o fallback global (automatico ou manual)
async function obterCotacaoParaData(data) {
  const porDia = await pool.query('SELECT cotacao FROM fx_rates WHERE data = $1', [data]);
  if (porDia.rows[0]) return parseFloat(porDia.rows[0].cotacao);

  const fallback = await pool.query('SELECT * FROM fx_fallback_config WHERE id = 1');
  const config = fallback.rows[0];

  if (config?.modo === 'manual' && config.valor_manual) {
    return parseFloat(config.valor_manual);
  }

  try {
    return await buscarCotacaoAoVivo();
  } catch (err) {
    // Se a API estiver com rate-limit, usa o ultimo valor conhecido em cache
    // antes de cair pro fallback fixo de 5.00
    if (cacheCotacaoAoVivo.valor) {
      return cacheCotacaoAoVivo.valor;
    }
    console.error('Erro ao buscar cotacao ao vivo, usando 5.00 como ultimo recurso:', err.message);
    return 5.0;
  }
}

async function salvarCotacaoDoDia(data, cotacao) {
  await pool.query(
    `INSERT INTO fx_rates (data, cotacao) VALUES ($1, $2)
     ON CONFLICT (data) DO UPDATE SET cotacao = EXCLUDED.cotacao`,
    [data, cotacao]
  );
}

async function salvarFallback(modo, valorManual) {
  await pool.query(
    `UPDATE fx_fallback_config SET modo = $1, valor_manual = $2, updated_at = NOW() WHERE id = 1`,
    [modo, valorManual || null]
  );
}

module.exports = { buscarCotacaoAoVivo, obterCotacaoParaData, salvarCotacaoDoDia, salvarFallback };
