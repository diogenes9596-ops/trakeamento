const axios = require('axios');
const pool = require('../db');

// Cache em memoria da cotacao ao vivo, pra nao estourar o limite de requisicoes
// da API quando sincronizamos varios dias/anuncios de uma vez
let cacheCotacaoAoVivo = { valor: null, buscadoEm: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
// Se a API recusar a chamada (rate limit, fora do ar), espera um pouco antes
// de tentar de novo -- sem isso, uma sincronizacao com muitos registros batia
// na API repetidas vezes em sequencia e tomava 429 (limite excedido) toda vez.
const RETRY_APOS_FALHA_MS = 60 * 1000; // 1 minuto
let ultimaFalhaEm = 0;

// Busca a cotação ao vivo. Tenta a AwesomeAPI primeiro (mesma fonte da
// plataforma original, atualizada em tempo real); se ela estiver fora do ar
// ou bloqueada (rate limit), tenta uma segunda fonte gratuita como backup
// antes de desistir -- assim o sistema consegue "sempre" ter uma cotacao
// real, mesmo se uma das duas fontes estiver com problema.
async function buscarCotacaoAoVivo() {
  const agora = Date.now();
  if (cacheCotacaoAoVivo.valor && (agora - cacheCotacaoAoVivo.buscadoEm) < CACHE_TTL_MS) {
    return cacheCotacaoAoVivo.valor;
  }
  if ((agora - ultimaFalhaEm) < RETRY_APOS_FALHA_MS) {
    throw new Error('Aguardando antes de tentar as APIs de cotacao de novo (falharam ha pouco)');
  }

  // Fonte principal: AwesomeAPI (cotacao comercial, atualizada em tempo real)
  try {
    const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL');
    const valor = parseFloat(data.USDBRL.bid);
    cacheCotacaoAoVivo = { valor, buscadoEm: agora };
    return valor;
  } catch (errPrincipal) {
    // Fonte backup: ExchangeRate-API (open.er-api.com), gratuita e sem chave,
    // atualizada uma vez por dia -- serve de rede de seguranca quando a
    // fonte principal estiver bloqueada/fora do ar.
    try {
      const { data } = await axios.get('https://open.er-api.com/v6/latest/USD');
      const valor = parseFloat(data.rates?.BRL);
      if (!valor) throw new Error('Fonte backup nao retornou BRL');
      cacheCotacaoAoVivo = { valor, buscadoEm: agora };
      return valor;
    } catch (errBackup) {
      ultimaFalhaEm = agora;
      throw errPrincipal;
    }
  }
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
    // Se as duas fontes falharem, usa o ultimo valor conhecido em cache
    // antes de cair pro fallback fixo de 5.00
    if (cacheCotacaoAoVivo.valor) {
      return cacheCotacaoAoVivo.valor;
    }
    console.error('Erro ao buscar cotacao ao vivo em ambas as fontes, usando 5.00 como ultimo recurso:', err.message);
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
